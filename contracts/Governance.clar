;; Governance - Sophisticated DAO Governance for EchoResearch

;; Traits
(use-trait res-token .ResToken.res-token)

;; Constants
(define-constant ERR-NOT-AUTHORIZED u100)
(define-constant ERR-PROPOSAL-EXISTS u101)
(define-constant ERR-PROPOSAL-NOT-FOUND u102)
(define-constant ERR-PROPOSAL-ENDED u103)
(define-constant ERR-PROPOSAL-ACTIVE u104)
(define-constant ERR-INSUFFICIENT-BALANCE u105)
(define-constant ERR-ALREADY-VOTED u106)
(define-constant ERR-VOTE-FAILED u107)
(define-constant ERR-QUORUM-NOT-MET u108)
(define-constant ERR-INVALID-PROPOSAL-TYPE u109)
(define-constant ERR-INVALID-AMOUNT u110)
(define-constant ERR-EXECUTION-FAILED u111)
(define-constant ERR-PROPOSAL-CANCELLED u112)
(define-constant ERR-NOT-PROPOSER u113)
(define-constant VOTE-THRESHOLD u1000) ;; Min tokens to create/vote on proposals
(define-constant QUORUM-PERCENT u20) ;; 20% of total supply needed for quorum
(define-constant VOTING-PERIOD u144) ;; ~1 day in blocks (assuming 10-min blocks)
(define-constant PROPOSAL-DELAY u10) ;; Delay before voting starts
(define-constant MAX-DESCRIPTION-LEN u500)

;; Data Variables
(define-data-var proposal-count uint u0)
(define-data-var total-supply-at-last-proposal uint u0)

;; Data Maps
(define-map proposals uint 
  {
    proposer: principal,
    start-block: uint,
    end-block: uint,
    votes-for: uint,
    votes-against: uint,
    votes-abstain: uint,
    executed: bool,
    cancelled: bool,
    recipient: (optional principal),
    amount: (optional uint),
    proposal-type: (string-ascii 20), ;; e.g., "fund-distribution", "param-change", "upgrade"
    description: (string-utf8 500),
    param-key: (optional (string-ascii 50)), ;; For param changes
    param-value: (optional uint) ;; Assuming uint params for simplicity
  }
)

(define-map votes { proposal-id: uint, voter: principal } { vote: (string-ascii 10) }) ;; "for", "against", "abstain"

(define-map params (string-ascii 50) uint) ;; Dynamic parameters, e.g., "quorum-percent"

;; Events (using print for simulation in Clarity)
(define-private (emit-event (event-name (string-ascii 50)) (data (tuple (key (string-ascii 50)) (value uint))))
  (print { event: event-name, data: data }))

;; Initialization
(begin
  (map-set params "quorum-percent" QUORUM-PERCENT)
  (map-set params "voting-period" VOTING-PERIOD)
  (map-set params "proposal-delay" PROPOSAL-DELAY)
)

;; Public Functions

(define-public (create-proposal 
  (recipient (optional principal)) 
  (amount (optional uint)) 
  (proposal-type (string-ascii 20))
  (description (string-utf8 500))
  (param-key (optional (string-ascii 50)))
  (param-value (optional uint)))
  (let 
    (
      (id (+ (var-get proposal-count) u1))
      (balance (unwrap-panic (contract-call? .ResToken get-balance tx-sender)))
      (current-block block-height)
      (start (+ current-block (map-get? params "proposal-delay") { default: PROPOSAL-DELAY }))
      (end (+ start (map-get? params "voting-period") { default: VOTING-PERIOD }))
      (total-supply (unwrap-panic (contract-call? .ResToken get-total-supply)))
    )
    (asserts! (>= balance VOTE-THRESHOLD) (err ERR-INSUFFICIENT-BALANCE))
    (asserts! (is-none (map-get? proposals id)) (err ERR-PROPOSAL-EXISTS))
    (asserts! (or 
                (is-eq proposal-type "fund-distribution")
                (is-eq proposal-type "param-change")
                (is-eq proposal-type "upgrade")) (err ERR-INVALID-PROPOSAL-TYPE))
    (asserts! (<= (len description) MAX-DESCRIPTION-LEN) (err ERR-INVALID-AMOUNT)) ;; Reuse err for len
    (if (is-eq proposal-type "fund-distribution")
      (asserts! (and (is-some recipient) (is-some amount) (> (unwrap-panic amount) u0)) (err ERR-INVALID-AMOUNT))
      (if (is-eq proposal-type "param-change")
        (asserts! (and (is-some param-key) (is-some param-value)) (err ERR-INVALID-AMOUNT))
        true ;; For upgrade, description suffices
      )
    )
    (map-set proposals id 
      {
        proposer: tx-sender,
        start-block: start,
        end-block: end,
        votes-for: u0,
        votes-against: u0,
        votes-abstain: u0,
        executed: false,
        cancelled: false,
        recipient: recipient,
        amount: amount,
        proposal-type: proposal-type,
        description: description,
        param-key: param-key,
        param-value: param-value
      }
    )
    (var-set proposal-count id)
    (var-set total-supply-at-last-proposal total-supply)
    (emit-event "proposal-created" { key: "id", value: id })
    (ok id)
  )
)

(define-public (vote (proposal-id uint) (vote-type (string-ascii 10)))
  (let 
    (
      (prop (unwrap! (map-get? proposals proposal-id) (err ERR-PROPOSAL-NOT-FOUND)))
      (balance (unwrap-panic (contract-call? .ResToken get-balance tx-sender)))
      (current-block block-height)
      (existing-vote (map-get? votes { proposal-id: proposal-id, voter: tx-sender }))
    )
    (asserts! (is-none existing-vote) (err ERR-ALREADY-VOTED))
    (asserts! (>= balance VOTE-THRESHOLD) (err ERR-INSUFFICIENT-BALANCE))
    (asserts! (and (>= current-block (get start-block prop)) (< current-block (get end-block prop))) (err ERR-PROPOSAL-ENDED))
    (asserts! (not (get cancelled prop)) (err ERR-PROPOSAL-CANCELLED))
    (asserts! (or (is-eq vote-type "for") (is-eq vote-type "against") (is-eq vote-type "abstain")) (err ERR-VOTE-FAILED))
    (map-set votes { proposal-id: proposal-id, voter: tx-sender } { vote: vote-type })
    (if (is-eq vote-type "for")
      (map-set proposals proposal-id (merge prop { votes-for: (+ (get votes-for prop) balance) }))
      (if (is-eq vote-type "against")
        (map-set proposals proposal-id (merge prop { votes-against: (+ (get votes-against prop) balance) }))
        (map-set proposals proposal-id (merge prop { votes-abstain: (+ (get votes-abstain prop) balance) }))
      )
    )
    (emit-event "vote-cast" { key: "proposal-id", value: proposal-id })
    (ok true)
  )
)

(define-public (execute-proposal (proposal-id uint))
  (let 
    (
      (prop (unwrap! (map-get? proposals proposal-id) (err ERR-PROPOSAL-NOT-FOUND)))
      (current-block block-height)
      (total-votes (+ (get votes-for prop) (get votes-against prop) (get votes-abstain prop)))
      (quorum-required (/ (* (var-get total-supply-at-last-proposal) (map-get? params "quorum-percent") { default: QUORUM-PERCENT }) u100))
    )
    (asserts! (> current-block (get end-block prop)) (err ERR-PROPOSAL-ACTIVE))
    (asserts! (not (get executed prop)) (err ERR-PROPOSAL-ENDED))
    (asserts! (not (get cancelled prop)) (err ERR-PROPOSAL-CANCELLED))
    (asserts! (> (get votes-for prop) (get votes-against prop)) (err ERR-VOTE-FAILED))
    (asserts! (>= total-votes quorum-required) (err ERR-QUORUM-NOT-MET))
    (if (is-eq (get proposal-type prop) "fund-distribution")
      (try! (as-contract (contract-call? .DAOTreasury withdraw (unwrap-panic (get amount prop)) (unwrap-panic (get recipient prop)))))
      (if (is-eq (get proposal-type prop) "param-change")
        (map-set params (unwrap-panic (get param-key prop)) (unwrap-panic (get param-value prop)))
        ;; For "upgrade", perhaps call another contract or just mark as executed
        true
      )
    )
    (map-set proposals proposal-id (merge prop { executed: true }))
    (emit-event "proposal-executed" { key: "proposal-id", value: proposal-id })
    (ok true)
  )
)

(define-public (cancel-proposal (proposal-id uint))
  (let 
    (
      (prop (unwrap! (map-get? proposals proposal-id) (err ERR-PROPOSAL-NOT-FOUND)))
      (current-block block-height)
    )
    (asserts! (is-eq (get proposer prop) tx-sender) (err ERR-NOT-PROPOSER))
    (asserts! (< current-block (get start-block prop)) (err ERR-PROPOSAL-ACTIVE))
    (asserts! (not (get cancelled prop)) (err ERR-PROPOSAL-CANCELLED))
    (map-set proposals proposal-id (merge prop { cancelled: true }))
    (emit-event "proposal-cancelled" { key: "proposal-id", value: proposal-id })
    (ok true)
  )
)

;; Read-Only Functions

(define-read-only (get-proposal (id uint))
  (map-get? proposals id)
)

(define-read-only (get-vote (proposal-id uint) (voter principal))
  (map-get? votes { proposal-id: proposal-id, voter: voter })
)

(define-read-only (get-param (key (string-ascii 50)))
  (map-get? params key)
)

(define-read-only (get-proposal-count)
  (var-get proposal-count)
)

(define-read-only (has-voted (proposal-id uint) (voter principal))
  (is-some (map-get? votes { proposal-id: proposal-id, voter: voter }))
)

(define-read-only (is-proposal-active (id uint))
  (let ((prop (map-get? proposals id)))
    (if (is-some prop)
      (let ((p (unwrap-panic prop)))
        (and (>= block-height (get start-block p)) (< block-height (get end-block p)) (not (get cancelled p))))
      false
    )
  )
)

(define-read-only (calculate-quorum (proposal-id uint))
  (let 
    (
      (prop (unwrap! (map-get? proposals proposal-id) (err ERR-PROPOSAL-NOT-FOUND)))
      (total-votes (+ (get votes-for prop) (get votes-against prop) (get votes-abstain prop)))
    )
    (ok (/ (* total-votes u100) (var-get total-supply-at-last-proposal)))
  )
)