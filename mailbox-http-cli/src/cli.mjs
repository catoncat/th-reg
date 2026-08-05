import { HttpMailbox } from './http-mailbox.mjs';

function parseArgs(argv, env) {
  const [command, ...rest] = argv;
  const args = {
    command,
    baseUrl: env.MAILBOX_HTTP_BASE_URL,
    email: null,
    limit: 20,
  };
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    if (arg === '--base-url') args.baseUrl = rest[++index];
    else if (arg === '--email') args.email = rest[++index];
    else if (arg === '--limit') args.limit = Number(rest[++index]);
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return args;
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  const args = parseArgs(argv, env);
  if (args.command !== 'messages') throw new Error('Usage: mailbox-http messages --email <address> [--limit 20]');
  const mailbox = new HttpMailbox({
    baseUrl: args.baseUrl,
    token: env.MAILBOX_HTTP_TOKEN,
    authHeader: env.MAILBOX_HTTP_AUTH_HEADER ?? 'authorization',
    authScheme: env.MAILBOX_HTTP_AUTH_SCHEME ?? 'Bearer',
    messagesPath: env.MAILBOX_HTTP_MESSAGES_PATH ?? '/messages',
  });
  const result = await mailbox.messages(args.email, args.limit);
  process.stdout.write(`${JSON.stringify(result)}\n`);
}
