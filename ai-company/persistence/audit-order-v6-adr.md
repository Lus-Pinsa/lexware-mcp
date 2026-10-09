# Audit append-order v6: design review

Draft design note. No schema migration or production change in this branch.

Problem: audit chain head and verifier currently sort by event timestamp and UUID, not by actual append order. Retention deletes by event time, which can remove an interior chain link. This document tracks a security finding pending independent review.
