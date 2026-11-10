# Development conventions

How we track work, branch, commit and release. Every change to the repository follows these rules.

```
issue #12 ──▶ branch feature/12-gke-cluster ──▶ commits ──▶ PR "Closes #12" ──▶ merge ──▶ issue closed
```

## Issues

Every piece of work starts with a GitHub issue. No issue, no branch.

### Creating an issue

- **Title**: what needs to be done, in the imperative: `Add GKE cluster with runner node pool`.
- **Body**:
  ```markdown
  ## Goal
  What we want and why (link the course support, e.g. C04).

  ## Tasks
  - [ ] Add NAT for private nodes
  - [ ] Create the cluster and the runner node pool
  - [ ] Cap the node pool at 3 nodes

  ## Done when
  A CI job runs on a self-hosted runner and the node pool scales up and down.
  ```
- **Labels**: one type label (`feature`, `fix`, `docs`, `ci`, `chore`) and one or more area labels
  (`foundation`, `access`, `serverless`, `observability`, `frontend`).
- **Assignee**: the person doing the work. Assign yourself before you start.

### Creating a branch for an issue

Create the branch yourself from an up-to-date `dev`, named after the issue's type and number
(see [Branch names](#branch-names)):

```bash
git switch dev && git pull
git switch -c feature/12-gke-cluster
```

### Closing an issue

Put `Closes #12` in the pull request description. GitHub links the PR to the issue and closes the issue
when the PR is merged. Large work is split into several issues, each with its own branch and PR.

## Branching model

```
feature/12-gke-cluster ──PR──┐
fix/18-proxy-timeout ────PR──┼──▶ dev ──release PR──▶ main ──tag v0.3.0──▶ deploy dev ──▶ deploy prd
docs/20-architecture ────PR──┘
```

We have two long-lived branches, both protected (no direct pushes, no force-pushes, no deletion):

| Branch | Role | Receives |
| --- | --- | --- |
| `dev` | Integration: the next release is assembled here | Pull requests from short-lived branches |
| `main` | Released code only, always deployable | Release pull requests from `dev` |

- All work happens on short-lived branches created from an up-to-date `dev`.
- A branch is merged into `dev` through a pull request only.
- `main` only moves through a release pull request from `dev` (see [Releases](#releases)).
- Deployments are triggered by release tags on `main`, never by a merge.

### Branch names

Format: `<type>/<issue-number>-<short-description>`

- lowercase, words separated by hyphens
- `<issue-number>` is the GitHub issue the branch works on
- `<short-description>` is 2 to 5 words

| Type | Use for | Example |
| --- | --- | --- |
| `feature/` | New functionality or infrastructure | `feature/12-gke-cluster` |
| `fix/` | Bug fixes | `fix/18-proxy-timeout` |
| `docs/` | Documentation only | `docs/20-architecture-diagram` |
| `ci/` | GitHub Actions workflows | `ci/22-deploy-serverless-stack` |
| `chore/` | Maintenance: dependencies, cleanup, config | `chore/25-remove-stale-workflows` |

### Branch lifecycle

1. Create the branch for its issue (see [Creating a branch for an issue](#creating-a-branch-for-an-issue)).
2. Keep the branch short-lived: one topic, merged within a few days.
3. If `dev` moves ahead, update your branch with `git merge dev` before asking for review.
4. Open a pull request into `dev` with `Closes #12` in its description.
   The Terraform checks (fmt, validate, plan for dev and prd) must pass.
5. Get **1 approval** from a teammate other than the author.
6. Merge with **Create a merge commit**, then delete the branch.

## Commit messages

We follow [Conventional Commits](https://www.conventionalcommits.org/).

```
<type>(<scope>): <subject>

<body, optional: why the change was made>

<footer, optional: Closes #12>
```

### Types

| Type | Use for |
| --- | --- |
| `feat` | A new feature or new infrastructure |
| `fix` | A bug fix |
| `docs` | Documentation only |
| `ci` | GitHub Actions workflows |
| `refactor` | Code change that neither fixes a bug nor adds a feature |
| `test` | Adding or updating tests |
| `chore` | Maintenance: dependencies, cleanup, config |

### Scopes

The part of the repository the commit touches:
`foundation`, `access`, `serverless`, `observability`, `proxy`, `workers`, `frontend`, `ci`, `docs`.
Leave the scope out when a commit spans several parts.

### Rules

- Subject in the imperative mood, lowercase, no period, 72 characters max:
  `add runner node pool`, not `Added runner node pool.`
- One logical change per commit.
- Use the body to explain **why**, when it is not obvious.
- Reference the issue in the footer: `Closes #12`.
- A breaking change gets a `!` after the type: `feat(serverless)!: switch grid to 64x64 tiles`.

### Examples

```
feat(foundation): add GKE cluster with runner node pool
fix(proxy): reject requests with an invalid Discord signature
ci: run terraform plan for the serverless stack
docs: add development conventions
chore: remove committed tfplan file
```

### Pull requests

Pull requests are merged with a merge commit, so **every commit of the branch ends up on `dev`, then on `main`**.
Each commit message must follow these rules, not only the last one.

Write the PR title in the same format: `feat(foundation): add GKE cluster with runner node pool`.

## Signed commits

All commits and tags must be signed and show as **Verified** on GitHub; `dev` and `main` reject unsigned commits.

```bash
gpg --list-secret-keys --keyid-format=long      # find your key id
git config --global user.signingkey <KEY_ID>
git config --global commit.gpgsign true
git config --global tag.gpgsign true
```

The email in `git config user.email` must be on your GPG key and verified on your GitHub account.
Check a commit with `git log --show-signature -1`.

## Releases

- A release is a signed tag on `main` following [Semantic Versioning](https://semver.org/): `vMAJOR.MINOR.PATCH`.
  - `PATCH` (`v0.3.1`): bug fix
  - `MINOR` (`v0.4.0`): new feature, nothing breaks
  - `MAJOR` (`v1.0.0`): breaking change
- We stay in `v0.x.y` until the project is ready for the defense, which is `v1.0.0`.
- Release when a feature works end to end on `dev`, not after every merge:
  1. Open a pull request from `dev` into `main`, titled `release: v0.4.0`, listing the issues it ships.
  2. Get **1 approval** and merge it with **Create a merge commit**.
  3. Tag the merge commit on `main`:
     ```bash
     git switch main && git pull
     git tag -s v0.4.0 -m "v0.4.0"
     git push origin v0.4.0
     ```
- Pushing the tag deploys to the dev environment, then to prd after approval.
- A fix needed on `main` is still made on a `fix/` branch from `dev`, then released the same way as a `PATCH` version.
