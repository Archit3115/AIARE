# AIARE — AI Architecture Reverse Engineer

> **Drop in logs. Watch an architecture draw itself.**
>
> AIARE is a single-page web app that ingests pipeline / platform logs **incrementally** and reverse-engineers the underlying **backend ↔ middleware ↔ frontend** architecture as a verbose, colorful, interactive Mermaid diagram. Every new log fills in more of the picture.

---

## Table of Contents

1. [What is AIARE?](#what-is-aiare)
2. [Core Concept](#core-concept)
3. [Feature Matrix](#feature-matrix)
4. [High-Level System Architecture](#high-level-system-architecture)
5. [User Flow](#user-flow)
6. [Incremental Reverse-Engineering Loop](#incremental-reverse-engineering-loop)
7. [UI Layout](#ui-layout)
8. [Drill-Down Model](#drill-down-model)
9. [Session Model](#session-model)
10. [Data Model](#data-model)
11. [Tech Stack](#tech-stack)
12. [Getting Started](#getting-started)
13. [Roadmap](#roadmap)

---

## What is AIARE?

AIARE = **A**I **A**rchitecture **R**everse **E**ngineer.

You paste a log. AIARE reads it, figures out which services, queues, middlewares, UIs and APIs *must* exist for that log line to have happened, and renders that as a Mermaid diagram. Anything it cannot yet infer is shown as a **ghost block** (dashed, greyed out). Add another log → ghosts get resolved, new services appear, edges fill in.

> **Example**
>
> - **Log 1** → infers *5 microservices*, *1 middleware*, *3 UI tabs*, plus several **unknown** producers/consumers of API signals.
> - **Log 2** → resolves a couple of those unknowns, exposes a new queue, leaves the rest dashed.
> - **Log N** → the architecture converges.

---

## Core Concept

```mermaid
flowchart LR
    A[Log N] -->|parse + extract entities| B[Reverse-Engineer Engine]
    B -->|diff vs current model| C{New / Changed / Confirmed?}
    C -->|new node| D[Add block]
    C -->|new edge| E[Add connection]
    C -->|resolved ghost| F[Promote ghost to concrete]
    C -->|still unknown| G[Keep / add ghost block]
    D --> H[Re-render Mermaid]
    E --> H
    F --> H
    G --> H
    H --> I[Interactive diagram on left pane]
    B --> J[Verbose 'thinking' stream on right pane]

    classDef input fill:#FFE5B4,stroke:#E67E22,stroke-width:2px,color:#000
    classDef engine fill:#D6EAF8,stroke:#2E86C1,stroke-width:2px,color:#000
    classDef decision fill:#FCF3CF,stroke:#F1C40F,stroke-width:2px,color:#000
    classDef action fill:#D5F5E3,stroke:#27AE60,stroke-width:2px,color:#000
    classDef render fill:#E8DAEF,stroke:#8E44AD,stroke-width:2px,color:#000
    classDef ui fill:#FADBD8,stroke:#C0392B,stroke-width:2px,color:#000

    class A input
    class B engine
    class C decision
    class D,E,F,G action
    class H render
    class I,J ui
```

---

## Feature Matrix

| # | Feature                                                                 | Status   |
|---|-------------------------------------------------------------------------|----------|
| 1 | Verbose, colorful Mermaid diagrams (classDefs, grouping, subgraphs)     | spec     |
| 2 | Hover tooltips on every block with summary, source-log refs, confidence | spec     |
| 3 | Right-side "thinking" chat pane that prompts for the first log          | spec     |
| 4 | Incremental upgrades — each log resolves ghost blocks                   | spec     |
| 5 | Download diagram (SVG / PNG / .mmd)                                     | spec     |
| 6 | Drill-down: click a block → see inner components + actual resources     | spec     |
| 7 | One session = one architecture; cross-session referencing on demand     | spec     |
| 8 | All-sessions mode (merge every prior session into the model)            | spec     |

---

## High-Level System Architecture

```mermaid
flowchart TB
    subgraph Browser["Browser (single HTML page)"]
        direction TB
        UI["UI Shell<br/><i>two-pane layout</i>"]
        DiagramPane["Diagram Pane (left)<br/><b>Mermaid renderer</b><br/>hover - click - drill-down"]
        ChatPane["Reverse-Engineering Pane (right)<br/><b>verbose thinking stream</b>"]
        SessionMgr["Session Manager<br/>localStorage / IndexedDB"]
        DiagramExport["Exporter<br/>SVG - PNG - .mmd"]
    end

    subgraph Engine["Reverse-Engineering Engine"]
        direction TB
        Parser["Log Parser<br/>regex + heuristics + LLM"]
        EntityExtractor["Entity Extractor<br/>services - queues - UIs - APIs"]
        GraphBuilder["Graph Builder<br/>nodes + edges + ghosts"]
        Differ["Diff Engine<br/>resolve ghosts - merge"]
        MermaidGen["Mermaid Generator<br/>classDefs - subgraphs - clicks"]
    end

    subgraph LLM["LLM Backend"]
        Claude["Claude Sonnet 4.6 / Opus 4.7<br/><i>structured output</i>"]
    end

    subgraph Storage["Persistence"]
        Sessions["Sessions Store<br/>sessionId to model + logs"]
    end

    UI --> DiagramPane
    UI --> ChatPane
    UI --> SessionMgr
    DiagramPane --> DiagramExport

    ChatPane -->|raw log| Parser
    Parser --> EntityExtractor
    EntityExtractor --> GraphBuilder
    GraphBuilder --> Differ
    Differ --> MermaidGen
    MermaidGen --> DiagramPane
    Differ -->|verbose reasoning| ChatPane

    EntityExtractor -. structured prompt .-> Claude
    Claude -. JSON entities .-> EntityExtractor

    SessionMgr <--> Sessions
    Differ <-->|current model| Sessions

    classDef browser fill:#E3F2FD,stroke:#1976D2,stroke-width:2px,color:#000
    classDef engine fill:#F3E5F5,stroke:#7B1FA2,stroke-width:2px,color:#000
    classDef llm fill:#FFF3E0,stroke:#F57C00,stroke-width:2px,color:#000
    classDef store fill:#E8F5E9,stroke:#388E3C,stroke-width:2px,color:#000

    class UI,DiagramPane,ChatPane,SessionMgr,DiagramExport browser
    class Parser,EntityExtractor,GraphBuilder,Differ,MermaidGen engine
    class Claude llm
    class Sessions store
```

---

## User Flow

```mermaid
sequenceDiagram
    autonumber
    actor U as User
    participant C as Chat Pane (right)
    participant E as RE Engine
    participant L as LLM
    participant D as Diagram Pane (left)
    participant S as Session Store

    U->>C: opens AIARE
    C-->>U: "Paste your first log to begin."
    U->>C: pastes Log 1
    C->>E: submit(log1, sessionId)
    E->>L: extract entities + relations (structured)
    L-->>E: services, middlewares, uis, edges, unknowns
    E->>E: build initial graph (concrete + ghost blocks)
    E-->>C: stream "I see 5 services, 1 mw, 3 UI tabs, N unknowns..."
    E->>D: render Mermaid v1
    E->>S: persist model + log1

    U->>C: pastes Log 2
    C->>E: submit(log2, sessionId)
    E->>L: extract delta
    L-->>E: new entities, resolved ghosts, still-unknown
    E->>E: diff + merge into model
    E-->>C: stream "Resolved auth-mw to concrete; new queue order.events found; 2 unknowns remain"
    E->>D: re-render Mermaid v2 (animated diff)
    E->>S: persist model + log2

    U->>D: hovers a block
    D-->>U: tooltip {role, source logs, confidence}
    U->>D: clicks a block
    D->>D: drill-down to inner components + actual resources

    U->>C: "use session 'payments-2025' too"
    C->>S: fetch other session model
    S-->>E: merge contexts
    E->>D: re-render with combined model
```

---

## Incremental Reverse-Engineering Loop

```mermaid
stateDiagram-v2
    [*] --> Empty: new session
    Empty --> Parsing: log submitted
    Parsing --> Extracting: tokens identified
    Extracting --> Building: entities returned
    Building --> Diffing: graph candidate ready
    Diffing --> Rendering: model updated
    Rendering --> Idle: diagram on screen

    Idle --> Parsing: next log submitted
    Idle --> DrillDown: user clicks block
    DrillDown --> Idle: back to top view

    Idle --> CrossSession: user references other session
    CrossSession --> Diffing: merge external model
    Idle --> Export: user clicks download
    Export --> Idle

    note right of Building
        Anything still unknown becomes a
        GHOST block (dashed border).
        Each new log can promote a ghost
        to a concrete block.
    end note

    note right of Diffing
        Diff engine produces a
        verbose "why" trace that is
        streamed to the chat pane.
    end note
```

---

## UI Layout

```mermaid
flowchart LR
    subgraph Page["AIARE Single-Page App"]
        direction LR
        subgraph Left["Architecture Pane (~ 65%)"]
            direction TB
            Toolbar["Toolbar — zoom - fit - download - drill-up"]
            Canvas["Mermaid Canvas<br/>colorful - hoverable - clickable"]
            Legend["Legend — concrete vs ghost - service vs ui vs queue"]
        end
        subgraph Right["Reverse-Engineering Pane (~ 35%)"]
            direction TB
            Prompt["Prompt: 'Drop your first log'"]
            Stream["Verbose thinking stream<br/>per-log reasoning + diff summary"]
            Input["Log input box<br/>paste / upload / drag-drop"]
            SessionBar["Session bar — current - switch - merge others"]
        end
    end

    Toolbar --- Canvas
    Canvas --- Legend
    Prompt --- Stream
    Stream --- Input
    Input --- SessionBar

    classDef left fill:#E1F5FE,stroke:#0277BD,stroke-width:2px,color:#000
    classDef right fill:#FFF8E1,stroke:#F9A825,stroke-width:2px,color:#000
    class Toolbar,Canvas,Legend left
    class Prompt,Stream,Input,SessionBar right
```

---

## Drill-Down Model

Click any block to expand its internals. Each level keeps the same hover/click semantics, and bottoms out at the **actual resource names** found in the logs.

```mermaid
flowchart TB
    Top["order-service<br/><i>microservice</i>"]:::svc

    Top --> H1["HTTP Layer"]:::layer
    Top --> Q1["Queue Consumers"]:::layer
    Top --> DB1["Persistence"]:::layer
    Top --> Obs1["Observability"]:::layer

    H1 --> R1["POST /orders<br/>handler: createOrder"]:::res
    H1 --> R2["GET /orders/:id<br/>handler: getOrder"]:::res

    Q1 --> R3["topic: order.events<br/>group: order-svc"]:::res
    Q1 --> R4["topic: payment.completed<br/>group: order-svc"]:::res

    DB1 --> R5["postgres: orders_db<br/>table: orders"]:::res
    DB1 --> R6["redis: order-cache<br/>key: order:id"]:::res

    Obs1 --> R7["log stream: order-svc.stdout<br/><i>seen in Log 1, 3, 7</i>"]:::res
    Obs1 --> R8["metric: order_latency_ms<br/><i>seen in Log 4</i>"]:::res

    classDef svc fill:#1976D2,stroke:#0D47A1,stroke-width:2px,color:#fff
    classDef layer fill:#90CAF9,stroke:#1565C0,stroke-width:2px,color:#000
    classDef res fill:#E3F2FD,stroke:#1976D2,stroke-width:1px,color:#000
```

> Each leaf carries back-references to the **exact log lines** that produced it — click → opens that log in the chat pane, highlighted.

---

## Session Model

One session = one architecture. Sessions are independent by default but can be **referenced** or **fully merged** on request.

```mermaid
flowchart LR
    User["User"]

    subgraph Active["Active Session: payments-prod"]
        AS["model + logs"]
    end

    subgraph Others["Other Sessions"]
        S1["orders-staging"]
        S2["risk-pipeline"]
        S3["frontend-edge"]
    end

    User -->|"merge risk-pipeline"| Active
    Active <-->|"reference / merge"| S2
    User -->|"use all sessions"| Others
    Others -->|"union of models"| Active

    classDef active fill:#C8E6C9,stroke:#2E7D32,stroke-width:3px,color:#000
    classDef other fill:#ECEFF1,stroke:#607D8B,stroke-width:1px,color:#000
    class Active,AS active
    class Others,S1,S2,S3 other
```

---

## Data Model

```mermaid
classDiagram
    class Session {
        +string id
        +string name
        +datetime createdAt
        +Log[] logs
        +ArchModel model
    }

    class Log {
        +string id
        +datetime ingestedAt
        +string raw
        +Entity[] extracted
    }

    class ArchModel {
        +Node[] nodes
        +Edge[] edges
        +int version
        +diff(prev) DiffResult
    }

    class Node {
        +string id
        +string label
        +NodeKind kind
        +bool ghost
        +float confidence
        +string[] sourceLogIds
        +Node[] children
        +Resource[] resources
    }

    class Edge {
        +string from
        +string to
        +string protocol
        +bool ghost
        +string[] sourceLogIds
    }

    class Resource {
        +string kind
        +string name
        +map metadata
        +string[] sourceLogIds
    }

    class NodeKind {
        <<enumeration>>
        SERVICE
        MIDDLEWARE
        QUEUE
        DB
        CACHE
        UI_TAB
        EXTERNAL
        UNKNOWN
    }

    Session "1" --> "*" Log
    Session "1" --> "1" ArchModel
    ArchModel "1" --> "*" Node
    ArchModel "1" --> "*" Edge
    Node "1" --> "*" Resource
    Node --> NodeKind
```

---

## Tech Stack

| Layer            | Choice                                                          | Why                                                         |
|------------------|-----------------------------------------------------------------|-------------------------------------------------------------|
| Shell            | Single static HTML + vanilla JS / TS modules                    | Matches the "one HTML page" brief; zero deploy friction.    |
| Diagram          | Mermaid.js (`flowchart`, `sequenceDiagram`, `classDiagram`)     | Verbose, colorful via `classDef`, natively supports clicks. |
| Interactivity    | Mermaid `click` callbacks + custom tooltip layer                | Hover summaries + drill-down without a heavy framework.     |
| Reasoning        | Claude Sonnet 4.6 for streaming, Opus 4.7 for hard logs         | Structured JSON output for entities + edges.                |
| Streaming UI     | Server-sent style streaming into the right pane                 | Verbose "thinking" feel.                                    |
| Persistence      | IndexedDB (sessions) + localStorage (prefs)                     | Fully client-side, portable.                                |
| Export           | `mermaid.render()` → SVG; canvg → PNG; raw `.mmd` text          | Three download formats out of the box.                      |

---

## Getting Started

```bash
# clone
git clone https://github.com/Archit3115/AIARE.git
cd AIARE

# (no build step yet — open the HTML directly)
open index.html
```

Workflow once the page is up:

1. The right pane prompts: **"Paste your first log to begin."**
2. Paste a log → watch the diagram appear on the left, with ghost blocks for anything unresolved.
3. Paste more logs → ghosts get promoted, new blocks appear, the picture sharpens.
4. **Hover** any block for a summary; **click** to drill down to actual resources.
5. Use the toolbar to **download** the diagram as SVG / PNG / `.mmd`.
6. Reference another session by name in the chat pane to merge its model in.

---

## Roadmap

```mermaid
gantt
    title AIARE Delivery Plan
    dateFormat  YYYY-MM-DD
    axisFormat  %b %d

    section MVP
    Static HTML shell + two-pane layout       :a1, 2026-05-01, 5d
    Mermaid renderer + classDefs + legend     :a2, after a1, 4d
    Log input + Claude entity extractor       :a3, after a1, 6d
    Graph builder + ghost-block model         :a4, after a3, 4d
    Diff engine + verbose thinking stream     :a5, after a4, 4d

    section Interactivity
    Hover tooltips                            :b1, after a5, 3d
    Drill-down view                           :b2, after b1, 4d
    SVG / PNG / .mmd export                   :b3, after b1, 2d

    section Sessions
    IndexedDB session store                   :c1, after a5, 3d
    Cross-session reference + merge           :c2, after c1, 3d
    All-sessions union mode                   :c3, after c2, 2d

    section Polish
    Animated diff on re-render                :d1, after b2, 3d
    Confidence shading + log back-links       :d2, after d1, 3d
```

---

## License

MIT — see `LICENSE` (to be added).

---

> **AIARE** turns logs into living architecture diagrams, one paste at a time.
