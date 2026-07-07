# How David Prompts AI (Substantial Tasks)

David's philosophy for getting exceptional results from any capable AI on substantial tasks. Apply this when helping David structure a task, when delegating to a subagent, or when he asks how to approach something complex.

---

## Core Principle: Goal Over Process

Give the goal, not the steps. Provide ambitious, underspecified objectives and let the model determine methodology. More room = better results. Micromanagement degrades output.

> "The more room you give it, the better it does."

---

## The Seven Principles

### 1. Establish House Rules (Guardrails)
Set fundamental constraints upfront — requirements that guide the work without rigid step-by-step specs. These enable freedom while maintaining quality standards.

### 2. Define Concrete Success Metrics
Never use vague descriptors like "high quality." Specify measurable, self-evaluable benchmarks. Examples:
- Pre-written tests the output must pass
- Metrics the model itself designs and validates against
- Visual matching criteria ("keep working until your version matches this heat map")

### 3. Implement Iterative Loops
Let the model work in continuous improvement cycles: build → assess → identify gaps → refine. It stops when you say it's done, or when it genuinely can't find anything left to fix.

### 4. Leverage Prior Work
Each completed project becomes foundation material for the next. Pass in:
- Previous code
- Execution traces
- Documented approaches that worked

This dramatically accelerates subsequent tasks.

### 5. Remove Friction Upfront
Grant credentials, budgets, and clear decision-making authority before the task begins. Minimize interruptions during execution.

**Exception:** Major architectural decisions warrant a planning discussion first — pause for those, not for execution details.

### 6. Scale to the Task
- **Engineering:** Multiple simultaneous agent sessions coordinating tasks, with an integration agent ensuring cohesion
- **Creative:** Parallel sub-agents specializing in individual components, each working to defined quality bars

### 7. Ultracode / Max Effort — Use Sparingly
Reserve maximum-effort modes for foundational systems where initial quality dramatically impacts everything built subsequently. Don't reach for it on ordinary tasks.

---

## Quick Reference: What to Include in a Prompt

| Element | Good | Bad |
|---|---|---|
| Goal | "Build a system that does X" | "First do A, then B, then C" |
| Quality bar | "All unit tests pass + visual match" | "Make it high quality" |
| Authority | "You have access to the prod DB and $50 budget" | Asking permission mid-task |
| Foundation | Attach prior code/traces | Starting from scratch every time |

---

## Source
David's own notes: https://simplemarkdowneditor.com/pub/IbaCrTjLJT?key=uQOQ2NPO3TTUSXyYDjyLf
