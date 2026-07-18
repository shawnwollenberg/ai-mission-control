import { hash } from "bcryptjs";

const password = process.argv[2];
if (!password || password.length < 12) throw new Error("Provide a password of at least 12 characters");
hash(password, 12)
  .then(console.log)
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
