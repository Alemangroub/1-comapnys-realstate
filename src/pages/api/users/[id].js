
import prisma from "../../../lib/prisma.js";
import { canAccessOwnUser, requireAuthenticatedUser } from "../../../lib/server-auth.js";

export const prerender = false;

export async function GET({ request, params }) {
    const { id } = params;

    if (!id) {
        return new Response(JSON.stringify({ error: "User ID is required" }), { status: 400 });
    }

    try {
        const { errorResponse, user: currentUser } = requireAuthenticatedUser(request);
        if (errorResponse) {
            return errorResponse;
        }

        if (!canAccessOwnUser(currentUser, id)) {
            return new Response(JSON.stringify({ error: "غير مسموح" }), { status: 403 });
        }

        const user = await prisma.user.findUnique({
            where: { id: id },
            include: {
                projects: true
            }
        });

        if (!user) {
            return new Response(JSON.stringify({ error: "User not found" }), { status: 404 });
        }

        return new Response(JSON.stringify({
            id: user.id,
            name: user.name,
            email: user.email,
            role: user.role,
            projectIds: user.projects.map(p => p.projectId)
        }), { 
            status: 200,
            headers: { 'Content-Type': 'application/json' }
        });
    } catch (error) {
        console.error("Error fetching user data:", error);
        return new Response(JSON.stringify({ error: "Internal Server Error" }), { status: 500 });
    }
}
