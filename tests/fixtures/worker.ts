import { Store } from "../../src/store.ts";
const [mode, room, member, prefix, rawCount] = process.argv.slice(2);
const store = new Store(room!);
try {
  if (mode === "write") for (let i = 0; i < Number(rawCount); i++) store.send({ from: member!, id: `${prefix}-${i}`, body: `message ${i}` });
  else if (mode === "claim") console.log(JSON.stringify(store.claim(member!, 20, Number(prefix))));
  else if (mode === "same") store.send({ from: member!, id: "same-retry", body: "same message" });
} finally { store.close(); }
