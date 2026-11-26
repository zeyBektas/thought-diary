<p align="center">
  <a href="http://nestjs.com/" target="blank"><img src="https://nestjs.com/img/logo-small.svg" width="120" alt="Nest Logo" /></a>
</p>

[circleci-image]: https://img.shields.io/circleci/build/github/nestjs/nest/master?token=abc123def456
[circleci-url]: https://circleci.com/gh/nestjs/nest

  <p align="center">A progressive <a href="http://nodejs.org" target="_blank">Node.js</a> framework for building efficient and scalable server-side applications.</p>
    <p align="center">
<a href="https://www.npmjs.com/~nestjscore" target="_blank"><img src="https://img.shields.io/npm/v/@nestjs/core.svg" alt="NPM Version" /></a>
<a href="https://www.npmjs.com/~nestjscore" target="_blank"><img src="https://img.shields.io/npm/l/@nestjs/core.svg" alt="Package License" /></a>
<a href="https://www.npmjs.com/~nestjscore" target="_blank"><img src="https://img.shields.io/npm/dm/@nestjs/common.svg" alt="NPM Downloads" /></a>
<a href="https://circleci.com/gh/nestjs/nest" target="_blank"><img src="https://img.shields.io/circleci/build/github/nestjs/nest/master" alt="CircleCI" /></a>
<a href="https://discord.gg/G7Qnnhy" target="_blank"><img src="https://img.shields.io/badge/discord-online-brightgreen.svg" alt="Discord"/></a>
<a href="https://opencollective.com/nest#backer" target="_blank"><img src="https://opencollective.com/nest/backers/badge.svg" alt="Backers on Open Collective" /></a>
<a href="https://opencollective.com/nest#sponsor" target="_blank"><img src="https://opencollective.com/nest/sponsors/badge.svg" alt="Sponsors on Open Collective" /></a>
  <a href="https://paypal.me/kamilmysliwiec" target="_blank"><img src="https://img.shields.io/badge/Donate-PayPal-ff3f59.svg" alt="Donate us"/></a>
    <a href="https://opencollective.com/nest#sponsor"  target="_blank"><img src="https://img.shields.io/badge/Support%20us-Open%20Collective-41B883.svg" alt="Support us"></a>
  <a href="https://twitter.com/nestframework" target="_blank"><img src="https://img.shields.io/twitter/follow/nestframework.svg?style=social&label=Follow" alt="Follow us on Twitter"></a>
</p>
  <!--[![Backers on Open Collective](https://opencollective.com/nest/backers/badge.svg)](https://opencollective.com/nest#backer)
  [![Sponsors on Open Collective](https://opencollective.com/nest/sponsors/badge.svg)](https://opencollective.com/nest#sponsor)-->

## Description

[Nest](https://github.com/nestjs/nest) framework TypeScript starter repository.

## Project setup

```bash
$ npm install
```

## Compile and run the project

```bash
# development
$ npm run start

# watch mode
$ npm run start:dev

# production mode
$ npm run start:prod
```

## Run tests

```bash
# unit tests
$ npm run test

# e2e tests
$ npm run test:e2e

# test coverage
$ npm run test:cov
```

## Deployment

When you're ready to deploy your NestJS application to production, there are some key steps you can take to ensure it runs as efficiently as possible. Check out the [deployment documentation](https://docs.nestjs.com/deployment) for more information.

If you are looking for a cloud-based platform to deploy your NestJS application, check out [Mau](https://mau.nestjs.com), our official platform for deploying NestJS applications on AWS. Mau makes deployment straightforward and fast, requiring just a few simple steps:

```bash
$ npm install -g @nestjs/mau
$ mau deploy
```

With Mau, you can deploy your application in just a few clicks, allowing you to focus on building features rather than managing infrastructure.

## Resources

Check out a few resources that may come in handy when working with NestJS:

- Visit the [NestJS Documentation](https://docs.nestjs.com) to learn more about the framework.
- For questions and support, please visit our [Discord channel](https://discord.gg/G7Qnnhy).
- To dive deeper and get more hands-on experience, check out our official video [courses](https://courses.nestjs.com/).
- Deploy your application to AWS with the help of [NestJS Mau](https://mau.nestjs.com) in just a few clicks.
- Visualize your application graph and interact with the NestJS application in real-time using [NestJS Devtools](https://devtools.nestjs.com).
- Need help with your project (part-time to full-time)? Check out our official [enterprise support](https://enterprise.nestjs.com).
- To stay in the loop and get updates, follow us on [X](https://x.com/nestframework) and [LinkedIn](https://linkedin.com/company/nestjs).
- Looking for a job, or have a job to offer? Check out our official [Jobs board](https://jobs.nestjs.com).

## Support

Nest is an MIT-licensed open source project. It can grow thanks to the sponsors and support by the amazing backers. If you'd like to join them, please [read more here](https://docs.nestjs.com/support).

## Stay in touch

- Author - [Kamil Myśliwiec](https://twitter.com/kammysliwiec)
- Website - [https://nestjs.com](https://nestjs.com/)
- Twitter - [@nestframework](https://twitter.com/nestframework)

## License

Nest is [MIT licensed](https://github.com/nestjs/nest/blob/master/LICENSE).

## Generate Module

nest g module ...

## Provision a Counselor

## Isolated Integration Tests

With Docker running, unset any inherited `DATABASE_URL` and production `NODE_ENV`, then run `npm run test:integration`. The command creates a uniquely named disposable PostgreSQL container with random credentials, verifies its identity and loopback endpoint, applies the existing migrations, runs the isolated suites serially, and removes only that container. It does not use the development database or seed scripts. If interrupted, the command reports the exact container for deliberate cleanup; do not remove unrelated containers or volumes. Tests use a temporary working directory instead of the project `.env`.

Public registration always creates a `CLIENT` account. Counselor accounts must be provisioned explicitly by a trusted operator with the standalone command below; this command is not part of normal startup, migrations, or deployment.

Required runtime variables are `COUNSELOR_EMAIL`, `COUNSELOR_PASSWORD`, `COUNSELOR_FIRST_NAME`, and `COUNSELOR_LAST_NAME`. Optional variables are `COUNSELOR_USERNAME` and `COUNSELOR_PHONE`. Supply the password through a non-echoing local prompt or a secret manager; do not put it in command arguments, source control, or logs.

### Local Integration Testing

Start PostgreSQL, apply the existing migrations, and run the standard Prisma seed so the `COUNSELOR` role exists. Set the required variables only in the local command environment, run the command from the backend project directory, and clear the password variable afterward:

```bash
npm run provision:counselor
unset COUNSELOR_PASSWORD
```

### Production Provisioning

An authorized operator should run this as a separate, one-off operation with production database access and credentials injected from the deployment secret manager. Run it only after the normal migrations and role seed; do not add it to application startup, routine deployment automation, or the standard seed command.

The command requires the existing `COUNSELOR` role, creates a counselor using the same password hashing convention as registration, and does not change an existing account. An existing counselor is reported as already provisioned; an email belonging to another role fails safely.

## Organization invitations

Current Platform Admins and effective Organization Admins in the named organization can manage invitations under `/organizations/:organizationId/invitations`: `POST` to create, `GET` to list, `GET /:invitationId` to inspect, and `POST /:invitationId/resend` or `/revoke`. A Platform Admin can still inspect or revoke while the organization is suspended. Pending invitations expire after seven days; resend rotates the secret without changing the deadline.

Accept using an authenticated `POST /organizations/invitations/accept` with a JSON `token`. The account must first prove ownership of its current email: authenticate, `POST /auth/email-verification/request` (the destination is read from the account), then `POST /auth/email-verification/confirm` with the separate challenge token. Challenges expire after 30 minutes; successful requests are limited to one per account per minute. Neither type of token belongs in an API URL or request logs. Registration, login and refresh otherwise behave as before. If an email-change flow is added later, it must clear `emailVerifiedAt` and invalidate the challenge in the same account update.

Acceptance creates only an ordinary membership. An existing ACTIVE or SUSPENDED episode yields `409` without consuming the invitation or changing roles or permission. LEFT or REMOVED history is retained when a new episode is created. Counselor invitations only admit existing, verified and currently approved counselors.

No production mail provider is configured. To enable sending, bind `MailDelivery` to a transactional email provider and configure its credentials, verified sender/domain, and templates or trusted client destination for the two message types. Honor the cancellation deadline, add deployment-level abuse limits, suppress token-bearing message content in request/provider logs, and disable mail click tracking. The default adapter fails closed with HTTP `503`; the integration fake is only available in tests. No runtime capture or token-return endpoint is provided.

The database transaction commits only after the provider acknowledges submission. If submission fails or times out, creation rolls back and resend keeps the old token. Email and PostgreSQL cannot commit atomically: if delivery is acknowledged but PostgreSQL subsequently rolls back, the delivered new token is unusable. Provider acknowledgement is not proof of inbox delivery.
