# calibrate

Calibrate is a hosted calorie tracker for people who want to lose or maintain weight by logging food and weight, then
comparing daily intake with an estimated target based on their profile. The official service is the default for routine
use; self-hosting remains available as an Advanced option for operators who want to run the application and database.

- Official service: https://calibratehealth.app
- Launch clients: English Web/PWA, Android phone, and Wear OS
- Stack: Expo Router + React Native Web, Node.js + TypeScript + Express, Postgres (Prisma)

Note: calibrate is not medical advice.

## License

Calibrate is developed in public and made available under the [PolyForm Shield License 1.0.0](LICENSE),
except where separate terms are stated. See [NOTICE](NOTICE) for the copyright holder, required notice,
third-party license boundaries, and reservation of trademark rights.

You may use, study, modify, and redistribute the software for purposes permitted by the license,
including personal self-hosting and noncompeting commercial work. The license restricts using the
software to provide competing products or services, including renamed apps, hosted services, and
free offerings. Its full terms, including the new-product and discontinued-product provisions, govern
what is permitted.

Shield does not generally require you to publish your source code or modifications. Redistributions
must include the license text or its URL and the `Required Notice:` line in [NOTICE](NOTICE). Uses
outside the license require separate permission from the relevant copyright holder. Dependencies
and third-party material retain their own licenses and attribution requirements.

Previously published versions retain their original licenses; this change does not revoke earlier
Apache 2.0 or other license grants. The current source is available under Shield's competition restrictions.

## Features

- Multi-user accounts (email/password)
- Profile-driven calorie math (Mifflin-St Jeor BMR, activity-based TDEE, fixed daily deficit targets)
- Daily food logging with fixed meal categories (manual entry + food database search)
- Food search + barcode scanning (FatSecret default; USDA optional with API key; Open Food Facts fallback)
- My Foods library + recipe builder for reusable entries
- Nutrition-label photo scanning with editable calories, serving quantity/unit, and a title before saving
- Lose It CSV import (food logs + weigh-ins)
- Weight logging + trend visualization
- Goal projection from a steady deficit
- Observational Health Connect activity that never automatically changes the calorie target
- Read-only MCP progress explorer with historical comparisons and contextual chat actions through revocable OAuth connections

#### FatSecret terms + attribution

If you enable the FatSecret provider, you must comply with the FatSecret Platform API Terms of Use and Attribution Policy.
The app includes the required "Powered by fatsecret" link on the landing page and above food search results when
FatSecret is the active provider; keep that link intact. Review the FatSecret platform docs for the latest terms and
attribution requirements: https://platform.fatsecret.com/docs/guides

## Code and documentation

- [Backend and account security](backend/README.md)
- [API contract](backend/openapi/README.md) and [client](packages/api-client/README.md)
- [Shared domain rules](shared/README.md)
- [Expo client](mobile/README.md) and [Wear](wear/README.md)
- [Development and native tools](scripts/README.md)
- [CI and release workflows](.github/workflows/README.md)
- [Validation policy](quality/README.md) and [browser tests](e2e/expo-web/README.md)
- [Deployment](deploy/README.md)

Document behavior beside the code: concise file/function comments and module README files.
Keep historical reports, generated prose, and PR screenshots outside the source tree.

## Development

Run `npm run dev` (`npm.cmd run dev` on Windows). The repository launcher prepares
an isolated database, seeded account, backend and Expo web client for this checkout.
Prerequisites, environment settings, worktree behavior and commands live in the
[development tools guide](scripts/README.md#development).

Use the [Expo guide](mobile/README.md#development) for native development and the
[local native workflow](scripts/README.md#local-native-workflow) for Android tooling
and the [Release workflow](.github/workflows/README.md#release) for protected publication. [Validation policy](quality/README.md) explains
which checks establish which kinds of evidence.

## Advanced self-hosting

The [deployment module](deploy/README.md) owns Compose setup for Caddy or Traefik,
external or private Postgres, encrypted backups, upgrades and restore drills.
The [release workflows](.github/workflows/README.md) own published artifacts.
