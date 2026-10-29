import prisma from "../../../lib/prisma.js";
import { requireAdmin } from "../../../lib/server-auth.js";
import { createAuditLog } from "../../../lib/audit.js";

export async function POST({ request }) {
    try {
        const { errorResponse, user } = requireAdmin(request);
        if (errorResponse) {
            return errorResponse;
        }

        const { id } = await request.json();

        if (!id) {
            return new Response(JSON.stringify({ error: "User ID is required" }), { status: 400 });
        }

        if (id === user.userId) {
            return new Response(JSON.stringify({ error: "لا يمكن حذف المستخدم الحالي" }), { status: 400 });
        }

        const targetUser = await prisma.user.findUnique({ where: { id } });

        // Clean up ERP assignments
        await prisma.salesProjectAssignment.deleteMany({ where: { userId: id } });
        await prisma.user.delete({ where: { id } });

        await createAuditLog({
            request,
            userId: user?.userId,
            userName: user?.name,
            userRole: user?.role,
            action: "DELETE",
            entity: "User",
            entityId: id,
            details: `حذف حساب الموظف/المستخدم: "${targetUser?.name || id}" (${targetUser?.email || ""}) بالصلاحية [${targetUser?.role || ""}]`,
            oldValues: { name: targetUser?.name, email: targetUser?.email, role: targetUser?.role },
            severity: "critical"
        });

        return new Response(JSON.stringify({ success: true }), { status: 200 });
    } catch (error) {
        console.error("Error deleting user:", error);
        return new Response(JSON.stringify({ error: "Internal Server Error" }), { status: 500 });
    }
}
