#!/usr/bin/env bun

import { markKobeInvocation, prepareCliEnvironment, prepareCliStateLayout } from "./rename-compat.ts"

markKobeInvocation()
prepareCliEnvironment()
prepareCliStateLayout()
await import("./index.ts")
