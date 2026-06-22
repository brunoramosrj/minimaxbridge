import "dotenv/config";
import { loginFromCredentials } from "./services/auth-minimax.ts";

const session = await loginFromCredentials();
if (!session) process.exit(1);
