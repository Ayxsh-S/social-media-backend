require("dotenv").config();
const { faker } = require("@faker-js/faker");
const bcrypt = require("bcryptjs");
const prisma = require("../src/prisma");

async function main() {
    await prisma.comment.deleteMany();
    await prisma.like.deleteMany();
    await prisma.post.deleteMany();
    await prisma.followRequest.deleteMany();
    await prisma.user.deleteMany();

    const password = await bcrypt.hash("password123", 10);

    const users = [];
    for (let i = 0; i < 18; i++) {
        const name = faker.person.fullName();
        const username = faker.internet.username().replace(/[^a-zA-Z0-9_]/g, "").slice(0, 16) + i;
        const email = faker.internet.email().toLowerCase();
        const user = await prisma.user.create({
            data: {
                name,
                username,
                email,
                password,
                bio: faker.person.bio(),
                avatarUrl: faker.image.avatar(),
            },
        });
        users.push(user);
    }

    for (let i = 0; i < users.length; i++) {
        const author = users[i];
        const postCount = faker.number.int({ min: 2, max: 5 });

        for (let p = 0; p < postCount; p++) {
            const post = await prisma.post.create({
                data: {
                    content: faker.lorem.paragraph(),
                    imageUrl: faker.datatype.boolean() ? faker.image.url() : null,
                    authorId: author.id
                },
            });

            const commenters = faker.helpers.arrayElements(users.filter((u) => u.id !== author.id), faker.number.int({ min: 0, max: 5 }));
            for (const commenter of commenters) {
                await prisma.comment.create({
                    data: {
                        content: faker.lorem.sentence(),
                        userId: commenter.id,
                        postId: post.id
                    },
                });
            }

            const likers = faker.helpers.arrayElements(users.filter((u) => u.id !== author.id), faker.number.int({ min: 0, max: 8 }));
            for (const liker of likers) {
                await prisma.like.upsert({
                    where: {
                        userId_postId: { userId: liker.id, postId: post.id },
                    },
                    update: {},
                    create: {
                        userId: liker.id,
                        postId: post.id,
                    },
                });
            }
        }
    }

    for (let i = 0; i < 25; i++) {
        const requester = faker.helpers.arrayElement(users);
        const recipient = faker.helpers.arrayElement(users.filter((u) => u.id !== requester.id));

        try {
            await prisma.followRequest.create({
                data: {
                    requesterId: requester.id,
                    recipientId: recipient.id,
                    status: "ACCEPTED",
                },
            });
        } catch {}
    }

    console.log("Seeded users, posts, comments, likes and follows.");
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
}).finally(async() => {
    await prisma.$disconnect();
});