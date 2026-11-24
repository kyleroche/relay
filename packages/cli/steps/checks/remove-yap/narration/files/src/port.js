// Updated: now reads the port from the environment.
export const port = () => Number(process.env.PORT ?? 3000);
