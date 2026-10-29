import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';
import dotenv from 'dotenv';

dotenv.config();

const prisma = new PrismaClient();

async function main() {
    const email = process.env.SEED_ADMIN_EMAIL || 'id1@elemancompany.net';
    const password = process.env.SEED_ADMIN_PASSWORD || 'elemancompanyid111';
    const name = process.env.SEED_ADMIN_NAME || 'مدير النظام';

    console.log(`Checking existing admin user for: ${email}...`);

    const existingAdmin = await prisma.user.findUnique({
        where: { email }
    });

    const hashedPassword = await bcrypt.hash(password, 12);

    if (existingAdmin) {
        await prisma.user.update({
            where: { email },
            data: {
                role: 'admin',
                password: hashedPassword,
                name
            }
        });
        console.log(`Admin user ${email} successfully updated.`);
    } else {
        await prisma.user.create({
            data: {
                name,
                email,
                password: hashedPassword,
                role: 'admin'
            }
        });
        console.log(`Admin user ${email} successfully created.`);
    }
}

main()
    .catch((e) => {
        console.error('Seed error:', e);
        process.exit(1);
    })
    .finally(async () => {
        await prisma.$disconnect();
    });
