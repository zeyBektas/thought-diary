export default () => ({
  app: {
    port: parseInt(process.env.PORT ?? '5000', 10),
    environment: process.env.NODE_ENV ?? 'development',
  },

  database: {
    url: process.env.DATABASE_URL!,
  },

  jwt: {
    secret: process.env.JWT_SECRET!,
    expiresIn: process.env.JWT_EXPIRES_IN ?? '7d',
  },
});
