import prisma from "../../../lib/prisma.js";
import bcrypt from "bcryptjs";
import { requireAdmin, validateEmail, validateRole } from "../../../lib/server-auth.js";
import { createAuditLog } from "../../../lib/audit.js";

export async function POST({ request }) {
    try {
        const { errorResponse, user: adminUser } = requireAdmin(request);
        if (errorResponse) {
            return errorResponse;
        }

        const { name, email, password, role } = await request.json();
        const normalizedName = typeof name === "string" ? name.trim() : "";
        const normalizedEmail = typeof email === "string" ? email.trim().toLowerCase() : "";

        if (!normalizedName || !normalizedEmail || !password || !role) {
            return new Response(JSON.stringify({ error: "جميع الحقول مطلوبة" }), { status: 400 });
        }

        if (!validateEmail(normalizedEmail)) {
            return new Response(JSON.stringify({ error: "البريد الإلكتروني غير صالح" }), { status: 400 });
        }

        if (!validateRole(role)) {
            return new Response(JSON.stringify({ error: "صلاحية المستخدم غير صالحة" }), { status: 400 });
        }

        if (typeof password !== "string" || password.length < 6) {
            return new Response(JSON.stringify({ error: "كلمة المرور يجب ألا تقل عن 6 أحرف" }), { status: 400 });
        }

        const existing = await prisma.user.findUnique({ where: { email: normalizedEmail } });
        if (existing) {
            return new Response(JSON.stringify({ error: "هذا البريد الإلكتروني مستخدم بالفعل." }), { status: 400 });
        }

        const hashedPassword = await bcrypt.hash(password, 10);

        const user = await prisma.user.create({
            data: { name: normalizedName, email: normalizedEmail, password: hashedPassword, role }
        });

        await createAuditLog({
            request,
            userId: adminUser?.userId,
            userName: adminUser?.name,
            userRole: adminUser?.role,
            action: "CREATE",
            entity: "User",
            entityId: user.id,
            details: `إضافة موظف/مستخدم جديد للنظام: "${user.name}" (${user.email}) بالصلاحية [${user.role}]`,
            newValues: { name: user.name, email: user.email, role: user.role },
            severity: "warning"
        });

        return new Response(JSON.stringify({ success: true, user: { id: user.id, name: user.name, email: user.email, role: user.role } }), { status: 201 });
    } catch (error) {
        console.error("Error creating user:", error);
        return new Response(JSON.stringify({ error: "Internal Server Error" }), { status: 500 });
    }
}
