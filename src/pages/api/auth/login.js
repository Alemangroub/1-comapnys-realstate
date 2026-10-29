import prisma from "../../../lib/prisma.js";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { createAuthCookie, getJwtSecretOrThrow } from "../../../lib/server-auth.js";
import { createAuditLog } from "../../../lib/audit.js";

const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const MAX_LOGIN_ATTEMPTS = 5;
const MAX_MAP_ENTRIES = 5000;
const loginAttempts = new Map();

// Periodic cleanup to prevent memory leaks
const cleanupTimer = setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of loginAttempts.entries()) {
        if (now > entry.resetAt) {
            loginAttempts.delete(key);
        }
    }
}, 5 * 60 * 1000);
if (typeof cleanupTimer.unref === "function") {
    cleanupTimer.unref();
}

function getClientKey(request, clientAddress, email) {
    const ip = clientAddress || request.headers.get("cf-connecting-ip") || request.headers.get("x-real-ip") || "local";
    return `${ip}_${email}`;
}

function isRateLimited(clientKey) {
    const now = Date.now();
    const entry = loginAttempts.get(clientKey);

    if (!entry || now > entry.resetAt) {
        if (loginAttempts.size >= MAX_MAP_ENTRIES) {
            // Evict oldest entry
            const firstKey = loginAttempts.keys().next().value;
            if (firstKey) loginAttempts.delete(firstKey);
        }
        loginAttempts.set(clientKey, { count: 0, resetAt: now + LOGIN_WINDOW_MS });
        return false;
    }

    return entry.count >= MAX_LOGIN_ATTEMPTS;
}

function recordFailedAttempt(clientKey) {
    const now = Date.now();
    const current = loginAttempts.get(clientKey);

    if (!current || now > current.resetAt) {
        loginAttempts.set(clientKey, { count: 1, resetAt: now + LOGIN_WINDOW_MS });
        return;
    }

    current.count += 1;
    loginAttempts.set(clientKey, current);
}

function clearFailedAttempts(clientKey) {
    loginAttempts.delete(clientKey);
}

// Dummy hash for constant-time comparison against nonexistent accounts
const DUMMY_HASH = "$2a$10$wT3wYy5C7jW0hG6a1O9Y7.e6O9wB11K9V8B2aN2K1E1S8V1c9P1G2";

export async function POST({ request, clientAddress }) {
    try {
        const body = await request.json().catch(() => null);
        if (!body) {
            return new Response(JSON.stringify({ error: "طلب غير صالح" }), { status: 400 });
        }

        const { email, password } = body;
        const normalizedEmail = typeof email === "string" ? email.trim().toLowerCase() : "";

        if (!normalizedEmail || !password || typeof password !== "string") {
            return new Response(JSON.stringify({ error: "الإيميل والباسورد مطلوبين" }), { status: 400 });
        }

        const clientKey = getClientKey(request, clientAddress, normalizedEmail);
        if (isRateLimited(clientKey)) {
            return new Response(JSON.stringify({ error: "تم تجاوز عدد محاولات تسجيل الدخول، حاول لاحقًا بعد 15 دقيقة" }), { status: 429 });
        }

        const user = await prisma.user.findUnique({ where: { email: normalizedEmail } });

        if (!user || !user.password) {
            // Mitigate timing attack
            await bcrypt.compare(password, DUMMY_HASH);
            recordFailedAttempt(clientKey);

            await createAuditLog({
                request,
                clientAddress,
                userName: normalizedEmail,
                userRole: "unknown",
                action: "FAILED_LOGIN",
                entity: "User",
                details: `محاولة دخول فاشلة بحساب غير موجود: "${normalizedEmail}"`,
                severity: "critical"
            });

            return new Response(JSON.stringify({ error: "بيانات الدخول غير صحيحة" }), { status: 401 });
        }

        const isValid = await bcrypt.compare(password, user.password);
        if (!isValid) {
            recordFailedAttempt(clientKey);

            await createAuditLog({
                request,
                clientAddress,
                userId: user.id,
                userName: user.name,
                userRole: user.role,
                action: "FAILED_LOGIN",
                entity: "User",
                entityId: user.id,
                details: `محاولة دخول فاشلة بكلمة مرور غير صحيحة للمستخدم: "${user.name}" (${user.email})`,
                severity: "critical"
            });

            return new Response(JSON.stringify({ error: "بيانات الدخول غير صحيحة" }), { status: 401 });
        }

        clearFailedAttempts(clientKey);

        const jwtSecret = getJwtSecretOrThrow();
        const token = jwt.sign(
            { userId: user.id, email: user.email, role: user.role, name: user.name },
            jwtSecret,
            { expiresIn: "7d" }
        );

        const headers = new Headers();
        headers.append("Set-Cookie", createAuthCookie(token));

        await createAuditLog({
            request,
            clientAddress,
            userId: user.id,
            userName: user.name,
            userRole: user.role,
            action: "LOGIN",
            entity: "User",
            entityId: user.id,
            details: `تسجيل دخول ناجح للمستخدم: "${user.name}" (${user.email}) بالصلاحية [${user.role}]`,
            severity: "normal"
        });

        return new Response(JSON.stringify({
            success: true,
            user: { id: user.id, name: user.name, email: user.email, role: user.role }
        }), { status: 200, headers });

    } catch (error) {
        console.error("Login error:", error);
        return new Response(JSON.stringify({ error: "حدث خطأ في السيرفر" }), { status: 500 });
    }
}
