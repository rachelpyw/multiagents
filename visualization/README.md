# AgentSchool classroom visualization

This local application replays observed AgentSchool interactions, knowledge state, misconception records, and independent assessment results. Run manifests distinguish recorded, live, and synthetic execution. Simulated assessment performance is not evidence about human learning.

## Verified upstream mapping

This integration was built against AgentSchool commit `97040be2a8a56486c8e7585a47f646ef6eb1f472`.

| Visualization evidence | AgentSchool source |
| --- | --- |
| Native JSONL envelope | `util/Recorder.py`: `time`, `event`, `details` |
| Speaker, audience, content, simulation time | `util/BroadcastMessage.py` and the `receiver` channel added by `util/BroadcastSys.py` |
| Teacher/student rounds | `run.py`: teacher move, concurrent student moves, then time advance |
| Knowledge records | `student/cognitive_module/memory.py`: knowledge tags, content, and misconception lists |
| Native mastery | `student/knowledge_graph.py`: probability `MasteryRecord.p` in the `0..1` range |
| Existing exercise path | `student/exercise.py`: personalized questions, answer keys in results, and mastery updates |

Audience channels (`student`, `teacher`, `all`, and `groupN`) are retained as audiences. They are never treated as student IDs. Node importance, memory volume, and attention are never displayed as mastery.

## Install and launch

Python 3.10+ and Node 18+ are required.

```bash
cd visualization/backend
python -m venv .venv
source .venv/bin/activate
pip install -e ".[native,test]"
PYTHONPATH=../.. AGENTSCHOOL_RUNS_DIR=../../logs uvicorn agentschool_viz.app:app --reload
```

In a second terminal:

```bash
cd visualization/frontend
npm install
npm run dev
```

Open <http://localhost:5173>. The room opens the newest saved run. With no saved runs, the available example is **Synthetic bird identification lab**; a failed real run never falls back to it. The fixture uses original pixel illustrations for bird-identification evidence.

On this machine the frontend is served at <http://localhost:5174> (5173 is occupied).

### Vercel deployment

Import the repository with its root directory left at `.`. The root `vercel.json` defines Vercel Services: the Vite frontend at `/` and a Python API gateway at `/api/*`. Without an explicit frontend service/build path, Vercel's **Other** preset publishes the repository root without building the app and `/` returns 404.

The gateway uses project-scoped Vercel OIDC authentication to start/resume a named **persistent Vercel Sandbox**. That sandbox runs the existing FastAPI backend and genuine native workers, with CPU embeddings, student memory, teacher experience, and saved runs on its persistent filesystem. This avoids treating a stateless Function's temporary disk and subprocess lifetime as durable classroom storage. All hosting remains within the same Vercel project.

The API build bundles committed native source with `git archive` and transfers that archive to the sandbox. Runtime startup does not need a GitHub login or GitHub token. Ignored local files, including `.env` and saved runs, are never included in the archive.

Set `SCHOOLAGENT_API_KEY` in Vercel's server environment. It is passed only to the backend; an internal derived token protects the sandbox's exposed API port. The browser never receives either secret. The gateway preserves HTTP errors and streams native SSE events. Requests wait up to four minutes for a cold runtime to become ready; failed or longer startups return an explicit 503, never synthetic dialogue.

The sandbox keeps one automatic filesystem snapshot when stopped and resumes it on later use. Sessions run for up to 45 minutes (compatible with Hobby limits); an interrupted unfinished run is explicitly marked failed after a new session starts. Completed memory checkpoints remain available. Initial provisioning installs a C++ compiler for native `hnswlib`, CPU PyTorch, and the original embedding model. Native packages and weights remain on the persistent filesystem. Sandbox compute and snapshot storage count against Vercel quotas/billing, in addition to OpenAI usage.

Local development still uses Vite's `/api` proxy to localhost; it does not provision Vercel compute.

### Mode dropdown and live classroom

The compact **Mode** menu offers **Teacher-led / Supervisor**, **Sequential / Relay**, **Peer network**, and **Shared blackboard**. Switching starts a new saved session, preserving earlier recordings:

- Teacher-led: coordinator delegates to individuals and receives their reports.
- Relay: actual native knowledge contributions pass as versioned artifacts only to the next permitted stage.
- Network: public contributions travel only along explicit directed routes, including teacher facilitation routes.
- Blackboard: permitted authors post versioned entries; the teacher reviews them when configured.

The header contains only **Mode**. When `SCHOOLAGENT_API_KEY` is configured, choosing a mode starts native AgentSchool; the transition from a demo asks for confirmation before billed OpenAI requests. Without a key, mode changes produce explicitly synthetic dialogue without API calls. The provider reads the Git-ignored root `.env`; do not paste the key into chat or model configuration. Role endpoints in `config/model.json` use the official OpenAI API and `gpt-4.1-mini`. Switching modes starts a fresh session and requests the previous worker stop at its next boundary.

Live mode now instantiates the genuine `student.cognitive_module.student.Student` and `teacher.teacher.Teacher`, not the previous conversation-only runner. Each student runs native **perceive → retrieve → reflect → plan → execute**, with native memory, embeddings, attention/stress updates, misconceptions, and knowledge-graph updates. Reflection still depends on AgentSchool's importance threshold; an invocation below that threshold is not reported as a generated reflection. The teacher runs native lesson planning/teaching, consumes native student feedback, and calls `update_experience`, persisting its experience vector database.

The integration adapts the outer scheduler to one UI-controlled class rather than running `run.py`'s entire school-day schedule. It does not replace the cognitive functions or train model weights. Students run concurrently except for ordered relay delivery. A run-local bird curriculum replaces the math textbook/taxonomy; configured fictional profiles supply all six students. The current embedding default is the real `BAAI/bge-small-zh-v1.5`, configurable through native `BGE_MODEL` / `BGE_MODEL_L` hooks. First launch downloads model weights and needs the `[native]` dependencies.

The configured turn budget bounds class rounds, **not the number of model requests**: native stages can make multiple requests per message. Lesson cost is therefore no longer capped at 64 requests. Message/time thresholds are checked between complete native rounds; an in-flight round and final feedback/experience update can exceed those thresholds. Native token-budget requests are rejected rather than advertised as enforced. Sessions are stored under `logs/native-*/visualization/`; isolated native code, student memories, knowledge graph, teacher databases, and class checkpoints are under that directory's `runtime/`. Stage telemetry contains endpoint/status evidence, not private reasoning. Failures are explicit; there is no lightweight or synthetic fallback.

The room uses the user-supplied empty classroom backdrop within the existing SVG renderer. The bottom dialogue uses 14px text with a scrollable three-line message area so the classroom occupies the remaining space. Standing, aisle movement, test seats, rings, labels, and routes use the same image-space coordinates; walking never changes learning records.

## Run AgentSchool and select a run

There is no AgentSchool account or special AgentSchool credential. The native runner uses an **OpenAI-compatible model provider's API key**, read from `SCHOOLAGENT_API_KEY`. Its teacher, student, textbook, and evaluation endpoints/model names are configured separately in `config/model.json`. The key must be accepted by those configured endpoints, which must be reachable. Set it in your local shell, not in source control or chat:

```bash
export SCHOOLAGENT_API_KEY="..."
python run.py
```

The additive hook writes `logs/<run-id>/visualization/manifest.json` and `events.jsonl`. Each run has its own directory, so initializing a later simulation does not overwrite earlier visualization evidence. While `run.py` is active the backend streams appended normalized events over SSE; completion changes the manifest to recorded mode. Replay controls never invoke AgentSchool rollback or runtime pause.

To replay a pre-instrumentation native run:

```bash
cd visualization/backend
python -m agentschool_viz.cli import-run ../../logs/<run-id> --project-root ../..
```

Legacy native logs provide observed interactions but not historical state snapshots or independent assessments, so those fields remain visibly unrecorded.

## State snapshots and assessments

The runner records a full initial state snapshot and one snapshot after each concurrent student round. State changes reference the round's interaction IDs with `context_only` attribution; the UI says that the update was recorded after the round rather than claiming a causal message.

The existing `student/exercise.py` remains assisted practice because it personalizes items, reveals answers, and updates knowledge. `agentschool_viz.assessment` defines a separate fixed-blueprint assessment path. It operates on a deep-copied snapshot, supplies no feedback, checks that learning state is unchanged, excludes errors and missing responses from scorable questions, and records coverage. The visualization supplies the bird blueprint and real OpenAI answer provider; no LLM-generated numerical score is used.

### Start test

The app opens in the classroom, even when the newest recording is a completed test. **Start test** is available for a live-backed native lesson, including a lesson that has finished. It requests a safe stop, waits for native feedback, experience updates, and checkpoint persistence, disables peer steering, and seats every student at a unique desk. Explicitly starting a test opens its dedicated view with progress, six bird pictures, separate identification/recall scores, and individual answer cards. **Back to classroom** returns to the seated room without stopping the test; **View test** reopens the results. **Next class** returns to the classroom.

New presets use the shared `fixtures/bird-identification-v2.json` curriculum: mallard, green-winged teal, rock pigeon, Canada goose, mute swan, and northern cardinal. All six species are taught; the test has six pictured identifications plus a separate image-free mallard bill-color recall question. Classification sends PNG pixels rasterized from the illustrations, not SVG metadata or species labels. Recall receives no picture. Answer keys stay observer-side. Tests use their source manifest's fixed blueprint; older four-question recordings remain unchanged and are labeled as an earlier version.

Each native answer starts from a fresh copy of that student's actual retained native knowledge, misconceptions, reflections, persona state, and chat-memory snapshot, saved as `native-test-contexts.json`. No global class transcript, peer answer, answer key, score feedback, or teacher assistance is supplied. Historical lightweight lessons remain testable with their original conversation-only context; they are not relabeled as native memory. Neither path proves model-weight learning, causal teaching gain, or delayed retention.

One six-student, seven-question test makes 42 billed answer requests, separately capped at 64. Duplicate Start test requests return the same test run. The new `logs/test-*/visualization/` recording preserves the source lesson history and references; original lesson events are not overwritten. `test-contexts.json` and `assessment.jsonl` retain provenance. Model errors are recorded per item, not counted as ordinary wrong answers; a test containing provider errors ends `complete_with_errors`. A demo cannot generate real test scores.

Each item receives a fresh copy of the pre-test snapshot, so a provider's modifications during one question cannot improve later answers. Scoring accepts case/whitespace-normalized exact answers and explicitly declared aliases, not substring matches or an LLM's opinion. Item IDs must be unique. Provider exceptions propagate from the model client and become assessment errors rather than ordinary dialogue or wrong classifications.

### Reading the animal results

The test overview separates bird identification, recall, and total answers in a student summary table rather than squeezing all questions into sidebar columns. Select a student to see animal cards: **Correct**, **Incorrect**, **No answer recorded**, **Tool / model error**, or **Not tested**. Unknown images, response text, and student records are never filled in. The gallery uses item metadata from the fixed blueprint or recorded item result; it cannot infer a species from a percentage. Answer keys and pictures in this observer view are not injected into agent observations.

The authored synthetic example maps its four questions to mallard identification, green-winged teal identification, bill-color recall, and a rock-pigeon transfer item. The original scores and missing answer text are preserved; the new species assignments are demonstration metadata, not recovered historical evidence. Only Avery, Blake, and Casey have test records. Devon, Emery, and Finley stay **Not tested**. The pigeon is explicitly a transfer item, not something the teacher is claimed to have taught.

Classification and recall are separate: 75% on four questions does **not** mean three correctly classified animals when one question tests recall. Correct recall answers already present at baseline are not counted as newly learned. No timed delayed-recall test exists in this fixture, so the interface does not claim lasting memory or prove that teaching caused a gain.

Real producers can record item `label`, `task_type` (`classification`, `recall`, `other`), `image_url`, `image_alt`, `prompt`, `response`, and `expected_response`. Tests can declare `test_timing` and `retention_delay_seconds`; a delayed-recall claim requires a positive declared interval. Scores/gains are kept within the same assessment blueprint and item set, incomplete tests are marked partial, and repeated student/checkpoint records are counted once in class averages.

**What is custom:** the fixed independent bird test is our observer-side evaluator, not upstream `student/exercise.py`, which remains assisted practice. The native engine teaches through text broadcasts; the independent evaluator supplies PNG images separately. Delayed recall is not scheduled. The localhost UI and synthetic replay need no model key; real lessons/tests use the configured remote provider, not a local language model.

### Returning to class and Next class

After the final test event, students return to their classroom positions and **Next class** replaces the test button. It creates a new native run from the source lesson's checkpoint: native memory/embeddings, scratch state, knowledge graph, buffered chat references, simulation clock, and teacher experience databases persist. Assessment scores, answer keys, and test feedback are never added to agents' lesson memory. Class numbers advance, and prior recordings remain immutable. A previous lightweight lesson cannot supply a native cognitive checkpoint; choose a mode once to begin a native class instead.

Completed native lessons also offer **Resume live class**, without requiring a test first. This continues from the latest saved checkpoint, not from an arbitrary point on the replay timeline. New preset classes adopt the six-bird curriculum while retaining native memory; custom lesson configurations are preserved.

### English-only classroom

App-launched native workers set `AGENTSCHOOL_OUTPUT_LANGUAGE=en`. A shared model-call policy requires English prose and JSON text values, including dialogue, misconceptions, reflection summaries, feedback, and teaching experience. Required upstream JSON keys and machine-coded teaching-method/focus labels retain their original form internally so the native algorithms still work. Teacher-generated control messages and action labels are localized too.

The app opens the newest explicitly English run, or its English synthetic example if none exists. Older non-English recordings are preserved, not silently translated or rewritten; they cannot seed a new English test/Next class. Choose Mode once to begin an English class. English classes preserve their native memory normally. It creates a new native run from the source lesson's checkpoint: native memory/embeddings, scratch state, knowledge graph, buffered chat references, simulation clock, and teacher experience databases persist. Assessment scores, answer keys, and test feedback are never added to agents' lesson memory. Class numbers advance, and prior recordings remain immutable. A previous lightweight lesson cannot supply a native cognitive checkpoint; choose a mode once to begin a native class instead.

The native transport and capture reject Mandarin in public dialogue/evidence fields with an explicit error rather than displaying it or inventing a translation. Internal schema keys and method/focus codes remain untouched. It creates a new native run from the source lesson's checkpoint: native memory/embeddings, scratch state, knowledge graph, buffered chat references, simulation clock, and teacher experience databases persist. Assessment scores, answer keys, and test feedback are never added to agents' lesson memory. Class numbers advance, and prior recordings remain immutable. A previous lightweight lesson cannot supply a native cognitive checkpoint; choose a mode once to begin a native class instead.

## Tests and build

```bash
cd visualization/backend
pytest

cd ../frontend
npm test
npm run build
```

## Architecture configuration and room controls

The Mode menu uses four starting configurations:

- **Supervisor**: a coordinator can delegate to agents and receive reports. Student-to-student delivery is blocked unless a directed peer route is enabled.
- **Pipeline**: a named, versioned artifact is delivered only to the next agent in the configured order.
- **Decentralized**: delivery is limited to explicitly enabled directed routes.
- **Blackboard**: shared entries retain author and version history and enforce separate read/write permissions.

Room coordinates are preview-only and are not part of the communication graph. Moving an avatar never appends a normalized event. The simplified interface does not expose the advanced editor or graph view. Switching Mode starts fresh; only **Next class** restores a completed native class checkpoint. This is a class-boundary continuation, not an arbitrary scheduler/queue rollback.

Display names use stable agent IDs resolved from the manifest. The translucent HUD uses Helvetica throughout. The compact bottom dialogue window puts time, task, steering state, and the utterance together without helper subtitles; exactly the displayed speaker's nameplate lights up. The minimalist sidebar offers **Character**, **Trail**, **AgentSchool function**, and **Outcome** filters, with the picture-based class overview preserved. The function filter and **Native calls** trail accept only cognitive-stage records carrying the matching native source path and hook: student `perceive`, `retrieve`, `reflect`, `plan`, `execute`, and teacher `update_experience`. Speech labels, state snapshots, generic agent actions, and the integration's `class_budget`/`runtime` hooks are not native functions. Options appear only after a matching call is recorded for the selected character.

In Room view, click a student to make that avatar active, then click a highlighted floor tile or use **W/A/S/D** (arrow keys also work) to move one adjacent isometric tile. Keyboard movement is ignored while an input, select, JSON editor, or other editable control has focus. Movement is preview-only and never appends a replay event.

In recorded/synthetic runs, press **Space** outside an editable control to reveal the next recorded classroom dialogue. This opens the transcript, selects the new entry, highlights the recorded route, and activates the corresponding question, explanation, or help pose. It never rewrites the recording. The synthetic lesson also plays automatically; before the first interaction no dialogue is invented.

### Autonomous lesson with live side conversations

With working upstream model credentials/dependencies, start the native runner from the repository root with:

```bash
AGENTSCHOOL_INTERACTIVE=1 python run.py
```

Point the API at the same `logs` directory and reload to open the newest English run in the classroom. The teacher and students continue their normal AgentSchool rounds automatically. Select a student and move them until their ring overlaps a permitted classmate's ring. An on-scene **[space] to talk** prompt appears; press **Space** outside a focused control or click the prompt. Occupying another avatar's tile is not necessary. Speaking does not block steering: one request at a time is queued in that run's local `conversations.sqlite`, then processed at the next safe native boundary. Viewing earlier dialogue in an active class also permits steering, targeting the current live class rather than rewriting the past. A student may decline to speak. The dialogue window and transcript show actual generated text as it is recorded, with an observer-request ID.

Both peer directions must be permitted by the **running** architecture, not merely a draft edited in the browser. Shared-blackboard steering posts publicly to permitted board readers/writers rather than bypassing policy with private peer messages. The backend checks permission before generation and again at native message delivery. Each student sees only their own previously delivered observations and chat memory. The teacher receives a separate copy only if its communication policy permits it; those messages enter normal next-round perception and can steer later decisions, without promising an effect or awarding knowledge/score changes. Independent-test and non-teaching phases reject requests. Preview walking only chooses whom to invite and never changes simulation state.

Scrubbing live history disables follow; return with **Follow live** before intervening. Recorded/synthetic runs cannot accept new conversations. No model dialogue is substituted when credentials or calls fail. Changing **Mode** now launches native AgentSchool directly; a separate `run.py` process is no longer required.

The overlap prompt is hidden while a request is pending, when the live class is unavailable, or when architecture policy, independent testing, or saved replay forbids an exchange. The dialogue HUD shows only **Steering…**, with a checkmark added after the backend reports completion. Rejected, declined, and failed requests retain explicit error/detail notices and never receive a completion check. **Follow live** controls only the displayed timeline, not whether an active class can accept input. Saved replays offer **Resume live class** instead of pretending their recorded dialogue can change. Observer-request IDs and downstream steering-context IDs remain in recorded evidence and the sidebar's **User steering** trail rather than extra HUD badges. These IDs establish input provenance, not causal influence or learning. The recorded arrow is thicker; selecting another student still filters routes normally.

Every student has a colored proximity ring at 25% opacity, increasing to 75% when it overlaps another student's ring. This is decorative proximity, not communication permission or evidence of learning. Small mustard diamonds indicate configured outgoing routes.

The room's time-and-task display uses the current recorded simulation timestamp and task, not measured wall-clock duration. During an independent test, all avatars sit at their own desks with illustrative writing poses, preview walking is suspended, and historical message arrows are hidden. The same applies when replay reaches recorded assessment events. No missing result or test duration is invented. Rewind restores the earlier room view.

Room arrows show only the selected student's four most recent sent/received routes, with direction from speaker to recipient. Selecting a different student refilters them; clicking or pressing Enter on an arrow opens its transcript evidence. Explicit recipient IDs are respected, including empty delivery lists. The unique teacher channel can resolve to the instructor, but class/group audiences are not expanded into unconfirmed individual deliveries. Configured permission alone does not create a recorded arrow.

The character inspector reconstructs evidence only through the current playhead: native endpoint statuses, interactions, knowledge-graph mastery, misconceptions, state changes, and independent assessments. Cognitive outcomes distinguish native modeled mastery from independently scored performance. Missing records remain missing, and empty charts, personality grids, and token counters are not shown.

The instructor view shows the recorded teaching period, target, retrieved experience, and filtered trail rather than an invented reasoning trace. AgentSchool `<think>` content is stripped and hidden chain-of-thought is not exposed. An experience update is marked complete only after the actual native update succeeds, never merely because the teacher entered its pending `update_experience` period.

Advanced configuration remains validated by the backend `ExperimentConfiguration` model, although its editor is not shown in the simplified interface. To enforce a configuration in a native AgentSchool run:

```bash
export AGENTSCHOOL_EXPERIMENT_CONFIG=/absolute/path/to/experiment.json
python run.py
```

`BroadcastSys` applies the architecture policy before both synchronous and asynchronous calls to an agent's receive method. Broadcast logs include `delivered_to` and `blocked_to`; the normalizer uses confirmed delivered IDs when available.

The current runtime supports verified route enforcement, supervisor gating, pipeline artifact channels, blackboard channels and permissions, phase configuration, message/turn budgets as configuration, and independent assessment conditions. The builder deliberately labels teacher-support mode as runtime-defined because current AgentSchool prompts do not expose a verified direct-answer/hint/questioning switch. Objectives are prompt instructions, not trained reinforcement-learning rewards.

The synthetic bird scenario demonstrates replay, visible state changes, misconceptions, independent assessment records, and fallback action poses. Pipeline handoffs and blackboard contributions animate when corresponding recorded `active_event` values are present; the fixture does not fabricate those events.

## Known limitations

- Native logs do not explicitly acknowledge delivery to each audience member. Broadcasts therefore remain audience indicators unless the receiver is a configured student ID.
- Native memory records do not explicitly mark misconception resolution. Disappearance from a partial snapshot is not treated as resolution.
- The live hook records state after a concurrent round, not after each individual asynchronous action.
- Native AgentSchool broadcasts carry text, not image attachments. The independent evaluator separately supplies test PNG images to its multimodal model.
- Live AgentSchool execution requires the configured model endpoints, API key, embedding dependencies, and model access. The fixture and adapter tests do not validate those external services.
- Resource budgets are validated and exported but upstream loops do not yet consume every budget field. Unsupported controls are not presented as active runtime switches.
- The UI runner projects native broadcasts/knowledge onto pipeline artifact and blackboard channels. This routing adapter is custom; it is not claimed to be an upstream-native architecture feature.
- Realized token reporting requires provider usage metadata, which the current upstream recorder does not capture consistently; missing usage remains missing.
- Original procedural sprites and fallback poses remain in use. No external asset pack is bundled, and the referenced packs are not assumed to share scale, licensing terms, or complete animation coverage.
