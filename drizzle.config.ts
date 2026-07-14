import { defineConfig } from 'drizzle-kit';
import * as dotenv from 'dotenv';

dotenv.config({ path: '.env.local' });
dotenv.config();

export default defineConfig({
    schema: './src/db/schema.ts',
    out: './drizzle',
    dialect: 'sqlite',
    dbCredentials: {
        url: process.env.DATABASE_PATH || './data/synapsis.db',
    },
});
