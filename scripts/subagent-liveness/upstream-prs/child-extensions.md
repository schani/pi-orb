Hosts need to supply selected inline extensions to children and detect incomplete loading before inference. This adds explicit child factories and fail-fast validation when supplied, including an empty list; ordinary discovery and child tool allowlists remain unchanged.

Validation: 1,768 package tests passed; typecheck and lint passed.
