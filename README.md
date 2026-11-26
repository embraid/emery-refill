# emery-refill
Synthetic fixture repository for rehearsing the Emery delivery workflow.

## Run the fixture

Use Node.js 24 or newer. The application and tests use Node.js built-ins.

```sh
cd refill-relay
npm test
npm start
```

Open the loopback address and port printed by the server. The first launch creates a local SQLite database and seeds fictional patients, pharmacies, prescribers, and accounts. The demo sign-in details are defined in `SYNTHETIC_ACCOUNTS` in `refill-relay/store.mjs`. Stop the server with Ctrl+C. Launch it again from the same directory to reuse the database.
