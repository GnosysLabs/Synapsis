
import sodium from 'libsodium-wrappers-sumo';

const BAD_KEY_B64 = "z+X63kLk1GoV0gJvPtqNisWuZ3XmlTbfMh9gW0xqcmg=";

async function main() {
    console.log('--- Initializing Sodium ---');
    await sodium.ready;
    console.log('Sodium Ready. Variants:', sodium.base64_variants);

    const variants = [
        { name: 'Default (undefined)', val: undefined },
        { name: 'ORIGINAL', val: sodium.base64_variants.ORIGINAL },
        { name: 'ORIGINAL_NO_PADDING', val: sodium.base64_variants.ORIGINAL_NO_PADDING },
        { name: 'URLSAFE', val: sodium.base64_variants.URLSAFE },
        { name: 'URLSAFE_NO_PADDING', val: sodium.base64_variants.URLSAFE_NO_PADDING },
    ];

    for (const v of variants) {
        process.stdout.write(`Testing: ${v.name}... `);
        try {
            // If checking NO_PADDING, manually strip padding for fairness
            let keyStr = BAD_KEY_B64;
            if (v.name.includes('NO_PADDING')) keyStr = keyStr.replace(/=/g, '');

            const buf = sodium.from_base64(keyStr, v.val);
            console.log(`SUCCESS! Length: ${buf.length}`);
        } catch {
            console.log(`FAILED.`);
        }
    }
}

main();
