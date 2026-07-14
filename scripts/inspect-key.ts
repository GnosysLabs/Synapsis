
import 'dotenv/config';
import { db } from '@/db';
import { handleRegistry } from '@/db/schema';
import { eq } from 'drizzle-orm';

const TARGET_DID = 'did:synapsis:75aea1b8630142f59e3cd893ec1d88e5'; // The one that failed

async function main() {
    console.log('--- Inspecting Remote Key ---');

    const entry = await db.query.handleRegistry.findFirst({
        where: { did: TARGET_DID },
    });

    if (!entry) {
        console.log('Registry entry not found!');
        return;
    }

    console.log(`Registry: ${entry.handle} @ ${entry.nodeDomain}`);

    // Try keys endpoint
    const keysUrl = `https://${entry.nodeDomain}/api/chat/keys?did=${encodeURIComponent(TARGET_DID)}`;
    console.log('Fetching:', keysUrl);

    try {
        const res = await fetch(keysUrl);
        if (res.ok) {
            const data = await res.json();
            console.log('Key Data:', data);

            const key = data.publicKey;
            console.log('Key:', key);
            console.log('Length:', key.length);

            // Checks
            const isBase64 = /^[A-Za-z0-9+/]*={0,2}$/.test(key);
            const isHex = /^[0-9a-fA-F]+$/.test(key);
            console.log('Is Base64-ish:', isBase64);
            console.log('Is Hex-ish:', isHex);
        } else {
            console.log('Fetch failed:', res.status, await res.text());
        }
    } catch (e) {
        console.error(e);
    }
}

main().catch(console.error).then(() => process.exit(0));
