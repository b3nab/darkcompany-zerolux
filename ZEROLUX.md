# zerolux - dark company os

current status: bootstrap pre-v0.0.1

ZeroLux is a open-source software (MIT license) to run a self-improving and autonomous dark company.
It can do more than a dark software factory and take care of the entire company working pipeline, starting from day -1.
It can self-build and extends intself, letting both humans and agents interact between them and have their digital workspace.

The Actors are both humans and agents.

The kernel of zerolux is written in Rust.
The clients are: the web interface (react), the desktop app (tauri) and the mobile app (expo).
There is the possibility to run the kernel in server mode and deploy it remotely on docker or kubernetes, or can be started with the desktop app which carries the server embedded.
Humans and agents can have chats and meetings, using LiveKit.
There is a "Drive" area, where can be shared files, uploaded or created by actors (agents or humans).
Organization chart mixed with humans and their agents, where agents hierarchy follows the humans' owners.
It has a projects and tasks area where actors sync and operate to achieve.
The updates are signed and automatic, both in server mode on VPS or local, no manual maintenance with backup and automatic migrations before every update.
It's easy to hire an already existing pi, claude-code or codex running on the human's machine (BYOH - bring your own harness).

# Core bootstrap features

- Dashboard overview and Onboarding flow
- Hire the agents, see past chats and create chats with the agents one-to-one and groups and start GTD
- Projects and tasks, agents+humans ready, inspired by Plane, Linear and Clickup
- Organization chart mixed with humans and agents
- Clean code (KISS, DRY, SINE, YAGNI principles in mind)
- Modular and extensible architecture, readable by humans and agents-ready

Currently we are starting one of three phases for zerolux, and we are at the first phase:

1. bootstrap - we are here now, we are currently building the first version of zerolux that will start improve autonously
2. dogfood - this is the phase where we'll improve and add modules to zerolux
3. release - this will be the first public release for the zerolux suite, starting at version v0.0.1
