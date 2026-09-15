Hosts need to prevent automatic parent turns after the operation owning a child is cancelled. This adds an optional per-child wake predicate checked at actual update/completion delivery, including withheld messages, without removing persisted outcomes or changing default delivery.

Validation: 1,767 package tests passed; typecheck and lint passed.
