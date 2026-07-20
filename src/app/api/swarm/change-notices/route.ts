import { NextResponse } from 'next/server';
import { z } from 'zod';
import {
  acceptChangeNotice,
  CHANGE_NOTICE_MAX_BODY_BYTES,
  changeNoticeEnvelopeSchema,
} from '@/lib/swarm/change-notice';
import { getPublicSwarmDomain, isPublicSwarmDomain } from '@/lib/swarm/node-domain';
import { FederationRequestBodyError, readLimitedJson } from '@/lib/swarm/request-body';
import { isFreshFederationTimestamp, verifySignature } from '@/lib/swarm/signature';
import { getTrustedSwarmReadPeerPublicKey } from '@/lib/swarm/registry';
import { isRateLimited } from '@/lib/rate-limit';

const signedEnvelopeSchema = changeNoticeEnvelopeSchema.extend({
  signature: z.string().min(1).max(2_048),
});

export async function POST(request: Request) {
  try {
    const data = signedEnvelopeSchema.parse(
      await readLimitedJson(request, CHANGE_NOTICE_MAX_BODY_BYTES),
    );
    if (!isFreshFederationTimestamp(data.timestamp)) {
      return NextResponse.json({ error: 'Stale relay envelope' }, { status: 400 });
    }
    const sender = getPublicSwarmDomain(data.sender);
    const ourDomain = getPublicSwarmDomain(process.env.NEXT_PUBLIC_NODE_DOMAIN);
    if (!sender || sender !== data.sender || !isPublicSwarmDomain(sender)) {
      return NextResponse.json({ error: 'Invalid relay sender' }, { status: 400 });
    }
    if (!ourDomain || sender === ourDomain) {
      return NextResponse.json({ error: 'Cannot relay notices to self' }, { status: 400 });
    }

    if (isRateLimited('change-notice-preauth-global', 6_000, 60_000)) {
      return NextResponse.json({ error: 'Change notice verification overloaded' }, { status: 429 });
    }
    const { signature, ...envelope } = data;
    const relayPublicKey = await getTrustedSwarmReadPeerPublicKey(sender);
    if (!relayPublicKey || !verifySignature(envelope, signature, relayPublicKey)) {
      return NextResponse.json({ error: 'Invalid or unestablished relay' }, { status: 403 });
    }
    if (isRateLimited('change-notice-authenticated-global', 6_000, 60_000)
      || isRateLimited(`change-notice-node:${sender}`, 120, 60_000)) {
      return NextResponse.json({ error: 'Too many change notice relays' }, { status: 429 });
    }

    let accepted = 0;
    let duplicates = 0;
    const rejected: Record<string, number> = {};
    for (const entry of envelope.notices) {
      const result = await acceptChangeNotice(entry);
      if (result.status === 'accepted') accepted += 1;
      else if (result.status === 'duplicate') duplicates += 1;
      else rejected[result.reason] = (rejected[result.reason] || 0) + 1;
    }
    return NextResponse.json({ accepted, duplicates, rejected });
  } catch (error) {
    if (error instanceof FederationRequestBodyError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: 'Invalid change notice envelope' }, { status: 400 });
    }
    console.error('[ChangeNotice] Route error:', error);
    return NextResponse.json({ error: 'Failed to process change notices' }, { status: 500 });
  }
}
