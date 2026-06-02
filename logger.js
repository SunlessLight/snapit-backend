import pino from 'pino';

const isDev = process.env.NODE_ENV !== 'production';

const logger = pino({
    level: process.env.LOG_LEVEL || 'info',
    ...(isDev && {
        transport: {
            target: 'pino-pretty',
            options: {
                colorize: true,
                translateTime: 'HH:MM:ss.l',
                ignore: 'pid,hostname',
            },
        },
    }),
});

process.on('uncaughtException', (err) => {
    logger.fatal({ err }, 'uncaughtException — process will exit');
    process.exit(1);
});

process.on('unhandledRejection', (reason) => {
    logger.fatal({ reason }, 'unhandledRejection');
});

export default logger;
