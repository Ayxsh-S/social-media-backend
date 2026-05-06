require("dotenv").config();
const express = require("express");
const cors = require("cors");
const cookieParser = require("cookie-parser");
const bcrypt = require("bcryptjs");

const prisma = require("./prisma");
const { signToken } = require("./auth");
const { requireAuth } = require("./middleware");

const app = express();

app.use(
    cors({
        origin: process.env.CLIENT_URL || "http://localhost:5173",
        credentials: true,
    })
);
app.use(express.json({ limit: "2mb" }));
app.use(cookieParser());

function setAuthCookie(res, token) {
    res.cookie("token", token, {
        httpOnly: true,
        sameSite: process.env.NODE_ENV === "production" ? "none" : "lax",
        secure: process.env.NODE_ENV === "production",
        maxAge: 1000*60*60*24*30,
    });
}

function sanitiseUser(user) {
    if (!user) return null;
    const { password, ...safe} = user;
    return safe;
}

async function getFollowStatus(viewerId, targetId) {
    if (viewerId === targetId) return "self";

    const relation = await prisma.followRequest.findUnique({
        where: {
            requesterId_recipientId: {
                requesterId: viewerId,
                recipientId: targetId,
            },
        },
    });

    const incoming = await prisma.followRequest.findUnique({
        where: {
            requesterId_recipientId: {
                requesterId: targetId,
                recipientId: viewerId,
            },
        },
    });

    if (relation?.status === "ACCEPTED") return "following";
    if (relation?.status === "PENDING") return "pending";
    if (incoming?.status === "PENDING") return "request_incoming";
    return "none";
}

app.get("/api/auth/me", requireAuth, async (req, res) => {
    res.json({ user: req.user });
});

app.post("/api/auth/signup", async (req, res) => {
    try {
        const { name, username, email, password } = req.body;
        if (!name || !username || !email || !password) {
            return res.status(400).json({ message: "All fields are required." });
        } 


        const existing = await prisma.user.findFirst({
            where: {
                OR: [{ email }, { username }],
            },
        });

        if (existing) {
            return res.status(409).json({ message: "Username or email already in use." });
        }


        const hashed = await bcrypt.hash(password, 10);
        const user = await prisma.user.create({
            data: {
                name, 
                username,
                email,
                password: hashed,
                avatarUrl: `https://api.dicebear.com/8.x/initials/svg?seed=${encodeURIComponent(username)}`,
            },
        });

        const token = signToken(user.id);
        setAuthCookie(res, token);
        res.json({ user: sanitiseUser(user) });
    } catch {
        res.status(500).json({ message: "Signup failed" });
    }
});


app.post("/api/auth/login", async (req, res) => {
    try {
        const { emailOrUsername, password } = req.body;

        const user = await prisma.user.findFirst({
            where: {
                OR: [{ email: emailOrUsername }, { username: emailOrUsername }],
            },
        });

        if (!user) return res.status(401).json({ message: "Invalid credentials." });

        const ok = await bcrypt.compare(password, user.password);
        if (!ok) return res.status(401).json({ message: "Invalid credentials." });
        
        const token = signToken(user.id);
        setAuthCookie(res, token);
        res.json({ user: sanitiseUser(user) });
    } catch {
        res.status(500).json({ message: "Login failed." });
    }
});

app.post("/api/auth/guest", async (_req, res) => {
    try {
        let guest = await prisma.user.findUnique({
            where: { username: "guest" },
        });

        if (!guest) {
            const hashed = await bcrypt.hash("guest-password-not-used", 10);
            guest = await prisma.user.create({
                data: {
                    name: "Guest User",
                    username: "guest",
                    email: "guest@demo.app",
                    password: hashed,
                    bio: "Browsing as a guest",
                    avatarUrl: "https://api.dicebear.com/8.x/initials/svg?seed=guest",
                },
            });
        }

        const token = signToken(guest.id);
        setAuthCookie(res, token);
        res.json({ user: sanitiseUser(guest) });
    } catch {
        res.status(500).json({ message: "Guest login failed" });
    }
});

app.post("/api/auth/logout", (_req, res) => {
    res.clearCookie("token", {
        httpOnly: true,
        sameSite: process.env.NODE_ENV === "production" ? "none" : "lax",
        secure: process.env.NODE_ENV === "production",
    });
    res.json({ ok: true });
});

app.get("/api/users", requireAuth, async (req, res) => {
    const users = await prisma.user.findMany({
        where: { id: { not: req.user.id } },
        orderBy: { createdAt: "desc" },
        select: {
            id: true,
            name: true,
            username: true,
            bio: true,
            avatarUrl: true,
            createdAt: true,
        },
    });

    const enriched = await Promise.all(
        users.map(async (u) => ({
            ...u,
            followStatus: await getFollowStatus(req.user.id, u.id),
        }))
    );

    res.json({ users: enriched });
});

app.get("/api/users/:username", requireAuth, async (req, res) => {
    const user = await prisma.user.findUnique({
        where: { username: req.params.username },
        select: {
            id: true,
            name: true,
            username: true,
            bio: true,
            avatarUrl: true,
            createdAt: true,
            posts: {
                orderBy: { createdAt: "desc" },
                include: {
                    author: {
                        select: {
                            id: true,
                            name: true,
                            username: true,
                            avatarUrl: true,
                        },
                    },
                    likes: true,
                    comments: {
                        orderBy: { createdAt: "asc" },
                        include: {
                            author: {
                                select: {
                                    id: true,
                                    name: true,
                                    username: true,
                                    avatarUrl: true,
                                },
                            },
                        },
                    },
                },
            },
        },
    });

    if (!user) return res.status(404).json({ message: "User not found" });

    const followStatus = await getFollowStatus(req.user.id, user.id);
    res.json({ user: { ...user, followStatus } });
});

app.patch("/api/users/me", requireAuth, async (req, res) => {
    const { name, bio, avatarUrl } = req.body;
    const updated = await prisma.user.update({
        where: { id: req.user.id },
        data: {
            ...(name !== undefined ? { name } : {}),
            ...(bio !== undefined ? { bio } : {}),
            ...(avatarUrl !== undefined ? { avatarUrl } : {}),
        },
    });
    
    res.json({ user: sanitiseUser(updated) });
});

app.post("/api/users/:id/follow-request", requireAuth, async (req, res) => {
    const targetId = req.params.id;
    const me = req.user.id;

    if (me === targetId) {
        return res.status(400).json({ message: "You cannot follow yourself." });
    }

    const existing = await prisma.followRequest.findUnique({
        where: {
            requesterId_recipientId: {
                requesterId: me,
                recipientId: targetId,
            },
        },
    });

    if (existing?.status === "ACCEPTED") {
        return res.status(400).json({ message: "Already following" });
    }

    if (existing?.status === "PENDING") {
        return res.status(400).json({ message: "Request already pending" });
    }

    await prisma.followRequest.create({
        data: {
            requesterId: me,
            recipientId: targetId,
            status: "PENDING",
        },
    });

    res.json({ ok: true });
});

app.post("/api/users/:id/accept-follow-request", requireAuth, async (req, res) => {
    const requesterId = req.params.id;
    const recipientId = req.user.id;

    const request = await prisma.followRequest.findUnique({
        where: {
            requesterId_recipientId: {
                requesterId,
                recipientId,
            },
        },
    });

    if (!request || request.status !== "PENDING") {
        return res.status(400).json({ message: "Follow request not found" });
    }

    const updated = await prisma.followRequest.update({
        where: { id: request.id },
        data: { status: "ACCEPTED" },
    });
    
    res.json({ request: updated });
});

app.post("/api/users/:id/decline-follow-request", requireAuth, async (req, res) => {
    const requesterId = req.params.id;
    const recipientId = req.user.id;

    const request = await prisma.followRequest.findUnique({
        where: {
            requesterId_recipientId: {
                requesterId,
                recipientId,
            },
        },
    });

    if (!request || request.status !== "PENDING") {
        return res.status(404).json({ message: "Follow request not found" });
    }

    await prisma.followRequest.delete({
        where: { id: request.id },
    });

    res.json({ ok: true });
});

app.post("/api/users/:id/unfollow", requireAuth, async (req, res) => {
    const targetId = req.params.id; 

    const relation = await prisma.followRequest.findUnique({
        where: {
            requesterId_recipientId: {
                requesterId: req.user.id,
                recipientId: targetId,
            },
        },
    });

    if (!relation) return res.status(404).json({ message: "Follow not found." });

    await prisma.followRequest.delete({
        where: { id: relation.id },
    });

    res.json({ ok: true });
});

app.get("/api/follow-requests/incoming", requireAuth, async (req, res) => {
    const requests = await prisma.followRequest.findMany({
        where: {
            recipientId: req.user.id,
            status: "PENDING",
        },
        orderBy: { createdAt: "desc" },
        include: {
            requester: {
                select: {
                    id: true,
                    name: true,
                    username: true,
                    avatarUrl: true,
                    bio: true,
                },
            },
        },
    });

    res.json({ requests });
});

app.get("/api/posts/feed", requireAuth, async (req, res) => {
    const following = await prisma.followRequest.findMany({
        where: {
            requesterId: req.user.id,
            status: "ACCEPTED",
        },
        select: { recipientId: true },
    });

    const authorIds = [req.user.id, ...following.map((f) => f.recipientId)];

    const posts = await prisma.post.findMany({
        where: { authorId: { in: authorIds } },
        orderBy: { createdAt: "desc" },
        include: {
            author: {
                select: {
                    id: true,
                    name: true,
                    username: true,
                    avatarUrl: true,
                },
            },
            likes: true,
            comments: {
                orderBy: { createdAt: "asc" },
                include: {
                    author: {
                        select: {
                            id: true,
                            name: true,
                            username: true,
                            avatarUrl: true,
                        },
                    },
                },
            },
        },
    });

    res.json({ posts });
});

app.post("/api/posts", requireAuth, async (req, res) => {
    const { content, imageUrl } = req.body;
    if (!content?.trim()) return res.status(400).json({ message: "Post content required" });

    const post = await prisma.post.create({
        data: {
            content: content.trim(),
            imageUrl: imageUrl?.trim() || null,
            authorId: req.user.id,
        },
        include: {
            author: {
                select: {
                    id: true,
                    name: true,
                    username: true,
                    avatarUrl: true,
                },
            },
            likes: true,
            comments: {
                orderBy: { createdAt: "asc" },

                include: {
                    author: {
                        select: {
                            id: true,
                            name: true,
                            username: true,
                            avatarUrl: true,
                        },
                    },
                },
            },
        },
    });

    res.json({ post });
});

app.post("/api/posts/:id", requireAuth, async (req, res) => {
    const post = await prisma.post.findUnique({
        where: { id: req.params.id },
        include: {
            author: {
                select: {
                    id: true,
                    name: true,
                    username: true,
                    avatarUrl: true,
                },
            },
            likes: true,
            comments: {
                orderBy: { createdAt: "asc "},
                include: {
                    author: {
                        select: {
                            id: true,
                            name: true,
                            username: true,
                            avatarUrl: true,
                        },
                    },
                },
            },
        },
    });

    if (!post) return res.status(404).json({ message: "Post not found" });
    res.json({ post });
});

app.post("/api/posts/:id/like", requireAuth, async (req, res) => {
    const postId = req.params.id;
    const userId = req.user.id;

    const existing = await prisma.like.findUnique({
        where: {
            userId_postId: { userId, postId },
        },
    });

    if (existing) {
        await prisma.like.delete({ where: { id: existing.id } });
    } else {
        await prisma.like.create({
            data: { userId, postId },
        });
    }

    const post = await prisma.post.findUnique({
        where: { id: postId },
        include: {
            likes: true,
            comments: true,
            author: {
                select: { id: true, name: true, username: true, avatarUrl: true },
            },
        },
    });

    res.json({ post });
});

app.post("/api/posts/:id/comments", requireAuth, async (req, res) => {
    const { content } = req.body;
    if (!content?.trim()) return res.status(400).json({ message: "Comment content required." });

    const comment = await prisma.comment.create({
        data: {
            content: content.trim(),
            userId: req.user.id,
            postId: req.params.id,
        },
        include: {
            author: {
                select: {
                    id: true,
                    name: true,
                    username: true,
                    avatarUrl: true,
                },
            },
        },
    });

    res.json({ comment });
});

app.delete("/api/comments/:id", requireAuth, async (req, res) => {
    const comment = await prisma.comment.findUnique({ where: { id: req.params } });
    if (!comment) return res.status(404).json({ message: "Comment not found." });
    if (comment.userId !== req.user.id) return res.status(403).json({ message: "Forbidden." });

    await prisma.comment.delete({ where: { id: comment.id } });
    res.json({ ok: true });
});

const port = process.env.PORT || 4000;
app.listen(port, () => {
    console.log(`Server running on port ${port}`);
});

