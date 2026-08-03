import { PrismaClient } from '@prisma/client';

const emotionTree = [
  {
    code: 'HAPPY',
    children: ['EXCITED', 'PROUD', 'GRATEFUL', 'CALM', 'CONTENT', 'HOPEFUL'],
  },
  {
    code: 'SAD',
    children: ['LONELY', 'DISAPPOINTED', 'GUILTY', 'HURT', 'HOPELESS', 'GRIEF'],
  },
  {
    code: 'ANGRY',
    children: ['ANNOYED', 'FRUSTRATED', 'RESENTFUL', 'FURIOUS', 'JEALOUS'],
  },
  {
    code: 'FEAR',
    children: ['ANXIOUS', 'NERVOUS', 'PANIC', 'OVERWHELMED', 'INSECURE'],
  },
  {
    code: 'DISGUST',
    children: ['ASHAMED', 'EMBARRASSED', 'SELF_DISGUST'],
  },
];

export async function seedEmotions(prisma: PrismaClient) {
  for (const emotion of emotionTree) {
    await prisma.emotion.upsert({
      where: {
        code: emotion.code,
      },
      update: {},
      create: {
        code: emotion.code,
      },
    });
  }

  for (const emotion of emotionTree) {
    const parent = await prisma.emotion.findUniqueOrThrow({
      where: {
        code: emotion.code,
      },
    });

    for (const child of emotion.children) {
      await prisma.emotion.upsert({
        where: {
          code: child,
        },
        update: {
          parentId: parent.id,
        },
        create: {
          code: child,
          parentId: parent.id,
        },
      });
    }
  }

  console.log('Emotions seeded');
}
