#!/usr/bin/env bun

import { markKobeInvocation, prepareCliEnvironment } from "./rename-compat.ts"

markKobeInvocation()
prepareCliEnvironment()
await import("./index.ts")
