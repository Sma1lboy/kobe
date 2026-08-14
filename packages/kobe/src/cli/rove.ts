#!/usr/bin/env bun

import { markRoveInvocation, prepareCliEnvironment, prepareCliStateLayout } from "./rename-compat.ts"

markRoveInvocation()
prepareCliEnvironment()
prepareCliStateLayout()
await import("./index.ts")
