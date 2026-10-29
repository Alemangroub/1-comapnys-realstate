import { PrismaClient } from '@prisma/client';
import dotenv from 'dotenv';

dotenv.config();

const dbUrl = process.env.DATABASE_URL;

console.log('----------------------------------------------------');
console.log('Testing PostgreSQL connection...');
console.log('DATABASE_URL:', dbUrl ? dbUrl.replace(/:([^:@]+)@/, ':****@') : 'Not defined!');
console.log('----------------------------------------------------');

if (!dbUrl) {
  console.error('❌ Error: DATABASE_URL is not set in your .env file.');
  process.exit(1);
}

const prisma = new PrismaClient();

async function testConnection() {
  try {
    // Attempt simple query
    await prisma.$queryRaw`SELECT 1 as connected`;
    console.log('✅ Connection to PostgreSQL database succeeded via Prisma!');
  } catch (error) {
    console.error('❌ Failed to connect to PostgreSQL database:');
    console.error(error.message || error);
    console.log('\n💡 Please verify:');
    console.log(' 1. Is PostgreSQL service running?');
    console.log(' 2. Are username, password, host, port, and database name correct in .env?');
  } finally {
    await prisma.$disconnect();
  }
}

testConnection();
