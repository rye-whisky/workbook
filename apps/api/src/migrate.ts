import "dotenv/config";
import { migrate } from "./db";

migrate();
console.log("SQLite schema is ready.");
