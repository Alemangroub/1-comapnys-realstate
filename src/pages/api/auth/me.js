import jwt from "jsonwebtoken";
import cookie from "cookie";
import { getJwtSecretOrThrow } from "../../../lib/server-auth.js";

export async function GET({ request }) {
    try {
        const cookieHeader = request.headers.get("cookie") || "";
        const cookies = cookie.parse(cookieHeader);
        const token = cookies.auth_token;

        // Check for token in Authorization header (for localStorage/simple browsers)
        const authHeader = request.headers.get("authorization");
        const headerToken = authHeader?.replace("Bearer ", "");

        const finalToken = token || headerToken;

        if (!finalToken) {
            return new Response(JSON.stringify({ authenticated: false, message: "No token found" }), { status: 401 });
        }

        const jwtSecret = getJwtSecretOrThrow();
        const decoded = jwt.verify(finalToken, jwtSecret);

        return new Response(JSON.stringify({
            authenticated: true,
            user: {
                userId: decoded.userId,
                email: decoded.email,
                role: decoded.role,
                name: decoded.name
            }
        }), { status: 200 });

    } catch (error) {
        console.error("JWT Verification Error:", error.message);
        return new Response(JSON.stringify({ authenticated: false, error: "غير مصرح" }), { status: 401 });
    }
}
