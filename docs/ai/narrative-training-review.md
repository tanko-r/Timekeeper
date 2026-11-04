# Narrative training examples for David's review

Status: **DRAFT — none approved for training yet.**

Edit the **Target narrative** directly to show exactly what you would want the app to write. Set each example's decision to `Approved`, `Approved as edited`, or `Reject`. Leaving it `Pending` means it is not approved. The matter context below is hypothetical; these are proposed teaching examples, not records of work actually performed.

These examples intentionally demonstrate substantive expansion rather than punctuation and capitalization alone. They also distinguish the app's Expand, Rewrite and Shorten actions. The target text is a proposal for your review, including the inferred detail.

## Proposed overall behavior

- **Expand:** unpack the stated work into plausible activities, explain the relationship between tasks, and use available matter context to identify the subject. Add useful detail rather than stock phrases.
- **Rewrite:** improve phrasing and organization while keeping roughly the same level of detail. It should produce a useful alternative to the original wording.
- **Shorten:** reduce wording while preserving distinct tasks, named people, documents and important issues, but omit excess verbiage and detail.
- Preserve present tense, semicolon-separated tasks and the attorney's billing register.
- Context identifies the matter, people and issues; it does not establish that every activity mentioned in prior entries happened again today.
- Extrapolate within the stated activity. New transactions, named documents, people, specific negotiated provisions, decisions and completed outcomes need support in the notes or context. Whether generic review steps may be inferred is one of the choices these examples ask you to calibrate.

Overall decision: **Approved as edited**

## 1. Your example — Expand without matter context

Decision: **Approved as edited**

**Action:** Expand

**Available context:** None.

**Input:**

> all hands call; prepare; messages with j. romero; confer with client

**Target narrative:**

> Prepare for and participate in all-hands call on [lease negotiations]; exchange messages with J. Romero regarding matters discussed and negotiations strategy; confer with client regarding outstanding issues and approach to resolution.



**Your notes:**
This infers what preparation involved and connects the communications to the call. It does not guess the transaction or document, but brackets operate as a placeholder for transaction details inferred from prior entries. It moves preparation before the call.

## 2. Same input — Expand with matter context

Decision: **Approved as edited**

**Action:** Expand

**Available context:** This matter concerns negotiation of a lease. J. Romero is another lawyer at the firm. The current issues list concerns lease revisions. No specific lease provision is identified.

**Input:**

> all hands call; prepare; messages with j. romero; confer with client

**Target narrative:**

> Review lease issues list and prepare for all-hands negotiations call; participate in call regarding outstanding lease issues; messages with J. Romero regarding issues raised during call; confer with client regarding negotiating approach and proposed response to remaining lease issues.

**Calibration point:** Context supplies the lease subject and issues list. The proposed target extrapolates the preparation and substance of the communications, but does not claim revisions were drafted, agreed or circulated. Compare this with Example 1 to establish how strongly matter context should influence the answer.

**Your notes:**


## 3. Lease review — Expand with inferred review detail

Decision: **Approved as edited**

**Action:** Expand

**Available context:** Lease negotiation. No particular provisions or client concerns are identified.

**Input:**

> review lease; email client

**Target narrative:**

> Review and analyze lease and identify issues requiring client input; compose email to client outlining lease issues and requesting direction regarding proposed revisions.

**Calibration point:** This adds analysis and the likely purpose of the email. It does not assert that the review covered particular provisions such as assignment, indemnity or renewal. If you want the model to infer those subjects as well, edit this target to demonstrate the desired level of specificity.

**Your notes:**


## 4. Named issue — Expand the work behind a revision

Decision: **Approved as edited**

**Action:** Expand

**Available context:** A crane swing license is being negotiated. L. Olson is the other attorney. Client comments concern crane height.

**Input:**

> revise license per client comments; email L. Olson

**Target narrative:**

> Review client comments regarding crane swing license and revise license to address same; compose email to L. Olson transmitting revised license and explaining proposed changes.

**Calibration point:** Infers review of comments before incorporating them, and transmission and explanation of the revised license. Does not assert that the other attorney accepted the changes.  Does not invent details.

**Your notes:**


## 5. Rewrite — improve expression without turning it into Expand

Decision: **Approved**

**Action:** Rewrite

**Available context:** Same as Example 2: lease negotiation and J. Romero on the client team.

**Input:**

> all hands call; prepare; messages with j. romero; confer with client

**Target narrative:**

> Prepare for and participate in all-hands call regarding lease negotiations; correspond with J. Romero regarding lease issues; confer with client regarding negotiating strategy.

**Calibration point:** A useful rewording and consolidation, shorter than the expanded target in Example 2. If Rewrite should also add significant detail, edit this target accordingly.

**Your notes:**


## 6. Shorten — preserve the substance while reducing words

Decision: **Approved**

**Action:** Shorten

**Available context:** None beyond the input.

**Input:**

> Review lease issues list and prepare for all-hands negotiations call; participate in call regarding outstanding lease revisions; exchange messages with J. Romero regarding issues raised during call; confer with client regarding negotiating approach and proposed response to remaining lease issues.

**Target narrative:**

> Review lease issues list and prepare for and participate in all-hands negotiations call; messages with J. Romero regarding lease revisions; confer with client regarding negotiating approach and response to remaining issues.

**Calibration point:** Retains preparation, participation, messages, client conference and the lease subject. This provides a contrast with Expand using the same underlying work.

**Your notes:**


## 7. A brief task — useful expansion without manufacturing a workstream

Decision: **Approved**

**Action:** Expand

**Available context:** Client requested a status update on outstanding lease comments. Recorded time is 0.1 hour; time is not part of the output.

**Input:**

> email client re status

**Target narrative:**

> Compose email to client regarding status of outstanding lease comments and anticipated response.

**Calibration point:** Adds the known subject and a plausible status-update detail. Does not turn a short email into document review, a conference or preparation of a separate issues list. Delete “anticipated response” if that exceeds the extrapolation you want.

**Your notes:**


## After review

Use only examples explicitly approved above, with your edited targets as authoritative. Unapproved examples remain proposals. A few approved examples establish the behavior; they are not, by themselves, evidence of reliable performance across all matters.

The next iteration should:

1. Encode the action, supplied matter context and input in training requests using the same request formats the app sends. The previous training mostly used `Work done:` with no action distinction.
2. Teach expansion and rewriting from approved pairs, including contrasts between actions on the same input. Stop using near-verbatim reconstructed inputs as the dominant training signal.
3. Align the model instructions and app prompts with the approved extrapolation policy, including plain Expand and Expand with task splitting.
4. Evaluate through the app's actual prompt builders and routes. Check useful added detail, response to action changes, retained tasks, correct names and contextual subjects, and unsupported claims. Exact reference matching alone is insufficient.
5. Keep separate unseen evaluation examples and preserve the current model as a comparison and rollback option. Examples you approve for training must not also count as held-out evaluation evidence.
