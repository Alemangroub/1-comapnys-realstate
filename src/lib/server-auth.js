import jwt from "jsonwebtoken";
import cookie from "cookie";
import prisma from "./prisma.js";

const ALLOWED_ROLES = new Set(["admin", "supervisor", "sales", "accountant", "engineer", "finance", "collector", "client"]);

function getJwtSecret() {
    const secret = import.meta.env.JWT_SECRET;

    if (!secret) {
        throw new Error("JWT_SECRET is missing");
    }

    return secret;
}

function getTokenFromRequest(request) {
    const cookieHeader = request.headers.get("cookie") || "";
    const cookies = cookie.parse(cookieHeader);
    const cookieToken = cookies.auth_token;
    const authHeader = request.headers.get("authorization");
    const headerToken = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : undefined;

    return cookieToken || headerToken || null;
}

export function getAuthenticatedUser(request) {
    try {
        const token = getTokenFromRequest(request);

        if (!token) {
            return null;
        }

        const decoded = jwt.verify(token, getJwtSecret());

        return {
            userId: decoded.userId,
            email: decoded.email,
            role: decoded.role,
            name: decoded.name,
        };
    } catch {
        return null;
    }
}

export function requireAuthenticatedUser(request) {
    try {
        const user = getAuthenticatedUser(request);

        if (!user) {
            return {
                errorResponse: new Response(JSON.stringify({ error: "غير مصرح" }), { status: 401 }),
                user: null,
            };
        }

        return { errorResponse: null, user };
    } catch {
        return {
            errorResponse: new Response(JSON.stringify({ error: "غير مصرح" }), { status: 401 }),
            user: null,
        };
    }
}

export function requireAdmin(request) {
    const { errorResponse, user } = requireAuthenticatedUser(request);

    if (errorResponse) {
        return { errorResponse, user: null };
    }

    if (user.role !== "admin") {
        return {
            errorResponse: new Response(JSON.stringify({ error: "غير مسموح" }), { status: 403 }),
            user: null,
        };
    }

    return { errorResponse: null, user };
}

export function canAccessOwnUser(user, targetUserId) {
    return user?.role === "admin" || user?.userId === targetUserId;
}

export async function hasProjectAccess(user, projectId) {
    if (!user || !projectId) {
        return false;
    }

    if (user.role === "admin") {
        return true;
    }

    // Check if user is assigned to this project
    const assignment = await prisma.salesProjectAssignment.findUnique({
        where: {
            userId_projectId: {
                userId: user.userId,
                projectId,
            },
        },
    });

    if (assignment) {
        return true;
    }

    // If user has specific assignments, they only access those assigned projects.
    // If they have 0 assignments, allow general finance/engineers for backward compatibility.
    const anyAssignmentCount = await prisma.salesProjectAssignment.count({
        where: { userId: user.userId }
    });

    if (anyAssignmentCount === 0) {
        if (user.role === "accountant" || user.role === "finance" || user.role === "engineer" || user.role === "supervisor" || user.role === "collector") {
            return true;
        }
    }

    return false;
}

export async function requireProjectAccess(request, projectId) {
    const { errorResponse, user } = requireAuthenticatedUser(request);

    if (errorResponse) {
        return { errorResponse, user: null };
    }

    const allowed = await hasProjectAccess(user, projectId);
    if (!allowed) {
        return {
            errorResponse: new Response(JSON.stringify({ error: "غير مسموح" }), { status: 403 }),
            user,
        };
    }

    return { errorResponse: null, user };
}

export function validateEmail(email) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

export function validateRole(role) {
    return ALLOWED_ROLES.has(role);
}

export function getJwtSecretOrThrow() {
    return getJwtSecret();
}

export function createAuthCookie(token) {
    const isProduction = import.meta.env.PROD;

    return cookie.serialize("auth_token", token, {
        httpOnly: true,
        path: "/",
        maxAge: 7 * 24 * 60 * 60,
        sameSite: "lax",
        secure: isProduction,
    });
}

export function clearAuthCookie() {
    const isProduction = import.meta.env.PROD;

    return cookie.serialize("auth_token", "", {
        httpOnly: true,
        path: "/",
        maxAge: 0,
        sameSite: "lax",
        secure: isProduction,
    });
}
