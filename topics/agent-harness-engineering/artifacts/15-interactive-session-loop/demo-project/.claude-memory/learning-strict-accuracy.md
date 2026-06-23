---
name: learning-strict-accuracy
description: Zero-Assumption and Why/How-First pedagogy rules — strict accuracy over fluency in learning sessions
metadata:
  type: feedback
---

In the learn-everything repo learning sessions, two pedagogy principles are critical:

1. **Zero-Assumption**: Never guess code behavior. If answering about claude-code or any external codebase, READ the source first (repo at `../claude-code/`). If uncertain, explicitly state "based on naming inference, accuracy unverified." Cross-layer terms (context/state/scope/process/swarm) MUST be prefix-qualified by layer and context.

2. **Why/How-First**: When explaining implementation details, must lay out background → alternatives → choice rationale → side effects → what (code literal). Roughly 50/30/20 split for why/how/what. Never give a "dictionary" answer — always build the mental model.

These came from real past mistakes (task 05, task 11, lesson 13) where instructor errors caused students to build wrong mental models. Accuracy > fluency.
