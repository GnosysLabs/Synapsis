/**
 * DID Migration Script
 * 
 * Converts users from legacy did:synapsis: format to new did:key: format
 * The new DID is derived from the user's public key
 */

import { db, users } from '../src/db';
import { eq } from 'drizzle-orm';

// Simple base58btc encoder (Bitcoin alphabet)
const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

function base58Encode(buffer: Uint8Array): string {
  const alphabet = BASE58_ALPHABET;
  let carry: number;
  const digits: number[] = [0];
  
  for (let i = 0; i < buffer.length; i++) {
    carry = buffer[i];
    for (let j = 0; j < digits.length; j++) {
      carry += digits[j] << 8;
      digits[j] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry) {
      digits.push(carry % 58);
      carry = (carry / 58) | 0;
    }
  }
  
  // Leading zeros
  for (let i = 0; i < buffer.length && buffer[i] === 0; i++) {
    digits.push(0);
  }
  
  return digits.reverse().map(d => alphabet[d]).join('');
}

async function migrateDIDs() {
  console.log('Starting DID migration...\n');

  if (!db) {
    console.error('Database not available');
    process.exit(1);
  }

  // Find all users with legacy did:synapsis: format
  const legacyUsers = await db.query.users.findMany({
    where: { did: { like: 'did:synapsis:%' } },
  });

  console.log(`Found ${legacyUsers.length} users with legacy DID format\n`);

  let migrated = 0;
  let failed = 0;

  for (const user of legacyUsers) {
    try {
      console.log(`Migrating: @${user.handle} (${user.did})`);

      if (!user.publicKey) {
        console.error(`  ❌ No public key for @${user.handle}, skipping`);
        failed++;
        continue;
      }

      // Generate new did:key from public key
      const publicKeyBytes = Buffer.from(user.publicKey, 'base64');
      const encoded = base58Encode(new Uint8Array(publicKeyBytes));
      const newDID = `did:key:z${encoded}`;

      console.log(`  → New DID: ${newDID}`);

      // Update user record
      await db.update(users)
        .set({ did: newDID })
        .where(eq(users.id, user.id));

      console.log(`  ✅ Migrated\n`);
      migrated++;

    } catch (err) {
      console.error(`  ❌ Failed to migrate @${user.handle}:`, err);
      failed++;
    }
  }

  console.log('\n═══════════════════════════════════════');
  console.log('Migration complete!');
  console.log(`  Migrated: ${migrated}`);
  console.log(`  Failed: ${failed}`);
  console.log(`  Total: ${legacyUsers.length}`);
  console.log('═══════════════════════════════════════');

  process.exit(0);
}

migrateDIDs().catch(err => {
  console.error('Migration failed:', err);
  process.exit(1);
});
