const prisma = require("./prisma");
const { verifyToken } = require("./auth");

async function requireAuth(req, res, next) {
    try {
        const token = req.cookies.token;
        if (!token) return res.status(401).json({ message: "Unauthorised" });

        const payload = verifyToken(token);
        const user = await prisma.user.findUnique({
            where: { id: payload.userId },
            select: {
                id: true,
                name: true,
                username: true,
                email: true,
                bio: true,
                avatarUrl: true,
                createdAt: true,
            },
        });

        if (!user) return res.status(401).json({ message: "Unauthorised" });

        req.user = user;
        next();
    } catch {
        return res.status(401).json({ message: "Unauthorised" });
    }
}

module.exports = { requireAuth };