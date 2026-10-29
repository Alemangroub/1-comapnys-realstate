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

        const { id, name, email, role, password } = await request.json();

        if (!id) {
            return new Response(JSON.stringify({ error: "User ID is required" }), { status: 400 });
        }

        const existingUser = await prisma.user.findUnique({ where: { id } });
        if (!existingUser) {
            return new Response(JSON.stringify({ error: "المستخدم غير موجود" }), { status: 404 });
        }

        const updateData = {};
        if (typeof name === "string" && name.trim()) {
            updateData.name = name.trim();
        }
        if (typeof email === "string" && email.trim()) {
            const normalizedEmail = email.trim().toLowerCase();
            if (!validateEmail(normalizedEmail)) {
                return new Response(JSON.stringify({ error: "البريد الإلكتروني غير صالح" }), { status: 400 });
            }
            updateData.email = normalizedEmail;
        }
        if (role) {
            if (!validateRole(role)) {
                return new Response(JSON.stringify({ error: "صلاحية المستخدم غير صالحة" }), { status: 400 });
            }
            updateData.role = role;
        }
        if (password) {
            if (typeof password !== "string" || password.length < 6) {
                return new Response(JSON.stringify({ error: "كلمة المرور يجب ألا تقل عن 6 أحرف" }), { status: 400 });
            }
            updateData.password = await bcrypt.hash(password, 10);
        }

        if (Object.keys(updateData).length === 0) {
            return new Response(JSON.stringify({ error: "لا توجد بيانات صالحة للتحديث" }), { status: 400 });
        }

        const user = await prisma.user.update({
            where: { id },
            data: updateData
        });

        await createAuditLog({
            request,
            userId: adminUser?.userId,
            userName: adminUser?.name,
            userRole: adminUser?.role,
            action: "UPDATE",
            entity: "User",
            entityId: user.id,
            details: `تحديث بيانات الموظف: "${user.name}" (${user.email}) - التعديل شمل: ${Object.keys(updateData).filter(k => k !== 'password').join(', ')}${updateData.password ? ' وتغيير كلمة المرور' : ''}`,
            oldValues: { name: existingUser.name, email: existingUser.email, role: existingUser.role },
            newValues: { name: user.name, email: user.email, role: user.role, passwordChanged: !!updateData.password },
            severity: "warning"
        });

        return new Response(JSON.stringify({ success: true }), { status: 200 });
    } catch (error) {
        console.error("Error updating user:", error);
        return new Response(JSON.stringify({ error: "Internal Server Error" }), { status: 500 });
    }
}
