# Design a Scalable Video Conferencing Platform

## 1. Introduction

This design describes a video conferencing platform that can support thousands of concurrent participants across many meetings. It uses ordinary backend services for accounts and meeting management, WebSockets for signaling and live updates, and WebRTC with Selective Forwarding Units (SFUs) for real-time media.

The important distinction is:

- **Signaling servers** exchange setup messages (for example, offer/answer and ICE candidates) so WebRTC peers can establish media connections. They do not carry the ongoing audio/video streams.
- **SFU media servers** receive participant media streams and selectively forward them to other participants. They carry the real-time media.

For large meetings, each participant normally sends one audio/video stream to an SFU. The SFU forwards suitable streams to other participants, avoiding the large upload cost of every participant sending directly to every other participant.

## 2. System architecture

```text
 Web, desktop, and mobile clients
 (REST/HTTPS, WebSocket, WebRTC)
       |                 \
       | HTTPS            \ WebSocket signaling and live events
       v                    v
 Global DNS / regional      Regional WebSocket + signaling servers
 load balancer                     |          \
       |                           |           \ signaling messages
       v                           |            v
 API Gateway                       |       SFU media servers <---- WebRTC media
 (auth, routing, limits)            |       (regional pools)       from clients
       |                           |          ^       |
       +---------------------------+----------|-------+ WebRTC media
       |                                      |
       v                                      |
 Stateless backend services                  |
  - Identity and authorization               |
  - Meeting service                          |
  - Participant/presence service             |
  - Notification service                     |
  - Recording/job service                    |
       |             |             |
       v             v             v
 PostgreSQL       Redis         Kafka
 (primary +       (meeting      (durable event
 read replicas)   cache/presence) streams)
                      |             |
                      |      Consumers: notifications,
                      |      analytics, recording, audit
                      |
                STUN/TURN services
                (connectivity fallback)

 External integrations: email provider, mobile push provider,
 object storage for recordings, monitoring/alerting platform
```

### Component responsibilities

| Component | Responsibility and reason for selection |
|---|---|
| Clients | Render the meeting UI, capture microphone/camera, call REST APIs, maintain a WebSocket for signaling and updates, and use WebRTC for media. |
| Global and regional load balancers | Route users to a healthy, nearby region and spread requests across instances. Health checks remove failed instances. Regional routing keeps media latency low. |
| API Gateway | Provides one public REST entry point. It verifies access tokens, applies rate limits, routes requests to services, and standardizes errors. It does not proxy media streams. |
| Identity and authorization service | Authenticates users and checks roles such as host, co-host, and participant before allowing actions. |
| Meeting service | Creates, reads, and ends meetings; enforces meeting settings; persists durable meeting data. |
| Participant and presence service | Tracks membership and temporary online status. Durable participant records go to PostgreSQL; frequently changing presence is held in Redis. |
| WebSocket/signaling servers | Keep client connections open and relay room events and WebRTC setup messages. They coordinate connections but do not forward audio/video. Instances are horizontally scalable; connection routing or a shared pub/sub layer delivers events across instances. |
| SFU media servers | Terminate WebRTC media connections and selectively forward audio/video tracks. They can forward a chosen set of video layers to each receiver, which reduces bandwidth and CPU compared with a full mesh. |
| STUN and TURN | STUN helps clients discover their public network address. TURN relays media when direct connectivity is blocked by NAT/firewalls. TURN is a connectivity fallback, not the normal media path. |
| PostgreSQL | Stores durable, relational records where transactions, constraints, and consistent updates matter. |
| Redis | Caches hot meeting metadata and stores short-lived participant presence, WebSocket routing data, and expiring coordination data. |
| Kafka | Carries asynchronous domain events to independent consumers, allowing notifications, analytics, recording workflows, and audit processing to scale separately. |
| Notification service | Sends in-app/WebSocket updates and, when needed, email or mobile push notifications through external providers. |
| Recording and object storage | Recording workers can subscribe to meeting events and store completed recordings in object storage rather than in the transactional database. |
| Monitoring and operations | Collects service, database, signaling, and media metrics; supports logs, traces, alerts, and incident diagnosis. |

### Typical meeting flow

1. A host authenticates and calls the meeting service to create a meeting. The service writes the meeting to PostgreSQL and may cache its metadata in Redis.
2. A participant calls the join endpoint. The backend checks the meeting, access policy, and capacity, then creates or updates a participant record and returns a short-lived join token and regional connection details.
3. The client opens a WebSocket to a signaling server. The signaling service associates the connection with the meeting and selected SFU.
4. The client and SFU exchange WebRTC signaling messages through the signaling server. ICE connectivity checks use STUN and, when necessary, TURN.
5. The client sends its media to the SFU over WebRTC. The SFU forwards selected tracks to subscribed participants. Signaling messages are not used for the media stream.
6. Join/leave and other domain events are published to Kafka. WebSocket instances notify connected participants; other consumers perform notifications, analytics, audit, or recording work.

## 3. REST API design

Base URL: `https://api.example.com/v1`. All endpoints require a bearer access token except where a deployment intentionally permits guest joins. The examples omit common headers such as `Authorization` and `Content-Type`.

| Operation | Method and endpoint | Purpose | Typical status codes |
|---|---|---|---|
| Create meeting | `POST /meetings` | Create a meeting owned by the authenticated host. | `201`, `400`, `401`, `403`, `429` |
| Join meeting | `POST /meetings/{meetingId}/participants` | Check access and register the caller as a participant; return signaling/SFU connection details. | `201`, `400`, `401`, `403`, `404`, `409`, `429` |
| Get meeting | `GET /meetings/{meetingId}` | Retrieve meeting metadata and the caller's permitted view of its state. | `200`, `401`, `403`, `404` |
| Add participant | `POST /meetings/{meetingId}/invitations` | Invite a user; this does not itself establish their media connection. | `201`, `400`, `401`, `403`, `404`, `409` |
| Remove participant | `DELETE /meetings/{meetingId}/participants/{userId}` | Host removes a participant and the service asks signaling/SFU control to disconnect them. | `204`, `401`, `403`, `404`, `409` |
| List participants | `GET /meetings/{meetingId}/participants` | List current or persisted participants, optionally paginated. | `200`, `401`, `403`, `404` |
| Mute/unmute participant | `PATCH /meetings/{meetingId}/participants/{userId}` | Host changes a participant's server-enforced audio mute state. | `200`, `400`, `401`, `403`, `404`, `409` |
| End meeting | `POST /meetings/{meetingId}/end` | End the meeting, disconnect participants, and emit a meeting-ended event. | `200`, `401`, `403`, `404`, `409` |

### Example requests and responses

#### Create a meeting

`POST /v1/meetings`

```json
{
  "title": "Project review",
  "scheduledStart": "2026-10-13T09:00:00Z",
  "scheduledEnd": "2026-10-13T10:00:00Z",
  "settings": {
    "waitingRoom": true,
    "allowParticipantScreenShare": false,
    "maxParticipants": 100
  }
}
```

`201 Created`

```json
{
  "id": "mtg_8a21",
  "title": "Project review",
  "status": "scheduled",
  "hostUserId": "usr_104",
  "joinUrl": "https://app.example.com/join/mtg_8a21",
  "scheduledStart": "2026-10-13T09:00:00Z",
  "scheduledEnd": "2026-10-13T10:00:00Z",
  "createdAt": "2026-10-12T09:15:00Z"
}
```

#### Join a meeting

`POST /v1/meetings/mtg_8a21/participants`

```json
{
  "displayName": "Sam Lee",
  "client": {
    "platform": "web",
    "supportsSimulcast": true
  }
}
```

`201 Created`

```json
{
  "participantId": "par_782",
  "meetingId": "mtg_8a21",
  "role": "participant",
  "status": "connected",
  "connection": {
    "signalingUrl": "wss://signal-eu.example.com",
    "sfuUrl": "https://sfu-eu.example.com",
    "iceServers": [
      { "urls": ["stun:stun.example.com:3478"] },
      {
        "urls": ["turn:turn.example.com:3478"],
        "username": "short-lived-user",
        "credential": "short-lived-credential"
      }
    ],
    "joinToken": "short-lived-signed-token"
  }
}
```

The token is short-lived and scoped to this meeting and participant; it is not a permanent credential. TURN credentials should also expire quickly.

#### Retrieve meeting details

`GET /v1/meetings/mtg_8a21`

`200 OK`

```json
{
  "id": "mtg_8a21",
  "title": "Project review",
  "status": "live",
  "hostUserId": "usr_104",
  "scheduledStart": "2026-10-13T09:00:00Z",
  "settings": {
    "waitingRoom": true,
    "maxParticipants": 100
  },
  "participantCount": 18
}
```

#### Invite a participant

`POST /v1/meetings/mtg_8a21/invitations`

```json
{
  "userId": "usr_205",
  "role": "participant",
  "sendNotification": true
}
```

`201 Created`

```json
{
  "meetingId": "mtg_8a21",
  "userId": "usr_205",
  "status": "invited",
  "invitationId": "inv_923",
  "createdAt": "2026-10-12T09:20:00Z"
}
```

#### Remove a participant

`DELETE /v1/meetings/mtg_8a21/participants/usr_205`

`204 No Content` (no response body). Only an authorized host/co-host can remove another participant. The service publishes a removal event so the signaling layer and SFU control plane can close that participant's session.

#### List participants

`GET /v1/meetings/mtg_8a21/participants?status=connected&limit=50`

`200 OK`

```json
{
  "items": [
    {
      "participantId": "par_782",
      "userId": "usr_104",
      "displayName": "Sam Lee",
      "role": "host",
      "status": "connected",
      "audioMuted": false,
      "joinedAt": "2026-10-13T09:02:14Z"
    }
  ],
  "nextCursor": null
}
```

#### Mute or unmute a participant

`PATCH /v1/meetings/mtg_8a21/participants/usr_205`

```json
{
  "audioMuted": true
}
```

`200 OK`

```json
{
  "meetingId": "mtg_8a21",
  "userId": "usr_205",
  "audioMuted": true,
  "updatedAt": "2026-10-13T09:12:00Z"
}
```

The backend authorizes the caller and sends the mute instruction to the media/control layer. Client-side UI state alone is not sufficient to enforce a host mute.

#### End a meeting

`POST /v1/meetings/mtg_8a21/end`

```json
{
  "reason": "host_ended"
}
```

`200 OK`

```json
{
  "id": "mtg_8a21",
  "status": "ended",
  "endedAt": "2026-10-13T10:01:05Z"
}
```

Errors use a consistent shape, for example: `404 Not Found` with `{"error":{"code":"MEETING_NOT_FOUND","message":"Meeting was not found."}}`. Use `409 Conflict` for a valid request that cannot be performed in the current state, such as joining an ended meeting. Create operations should support an idempotency key so client retries do not create duplicate meetings or invitations.

## 4. Database design

Use PostgreSQL for durable account, meeting, membership, invitation, and meeting-history data. These records have relationships and require constraints and transactions—for example, a participant must refer to an existing meeting and user. PostgreSQL also supports indexing and read replicas for read-heavy workloads.

The following is a simplified schema. IDs may be UUIDs in production; readable string IDs are used in the API examples.

```sql
CREATE TABLE users (
    id              UUID PRIMARY KEY,
    email           TEXT NOT NULL UNIQUE,
    display_name    TEXT NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE meetings (
    id              UUID PRIMARY KEY,
    host_user_id    UUID NOT NULL REFERENCES users(id),
    title           TEXT NOT NULL,
    status          TEXT NOT NULL
                    CHECK (status IN ('scheduled', 'live', 'ended', 'cancelled')),
    scheduled_start TIMESTAMPTZ,
    scheduled_end   TIMESTAMPTZ,
    started_at      TIMESTAMPTZ,
    ended_at        TIMESTAMPTZ,
    settings        JSONB NOT NULL DEFAULT '{}',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE participants (
    id              UUID PRIMARY KEY,
    meeting_id      UUID NOT NULL REFERENCES meetings(id),
    user_id         UUID NOT NULL REFERENCES users(id),
    role            TEXT NOT NULL
                    CHECK (role IN ('host', 'cohost', 'participant')),
    status          TEXT NOT NULL
                    CHECK (status IN ('invited', 'waiting', 'connected', 'left', 'removed')),
    audio_muted     BOOLEAN NOT NULL DEFAULT false,
    joined_at       TIMESTAMPTZ,
    left_at         TIMESTAMPTZ,
    UNIQUE (meeting_id, user_id)
);

CREATE TABLE meeting_records (
    id              UUID PRIMARY KEY,
    meeting_id      UUID NOT NULL UNIQUE REFERENCES meetings(id),
    started_at      TIMESTAMPTZ NOT NULL,
    ended_at        TIMESTAMPTZ,
    peak_participants INTEGER NOT NULL DEFAULT 0,
    recording_uri   TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX meetings_host_created_idx ON meetings(host_user_id, created_at DESC);
CREATE INDEX meetings_status_start_idx ON meetings(status, scheduled_start);
CREATE INDEX participants_meeting_status_idx ON participants(meeting_id, status);
CREATE INDEX participants_user_idx ON participants(user_id);
```

### Keys and relationships

- `users.id`, `meetings.id`, `participants.id`, and `meeting_records.id` are primary keys, uniquely identifying each row.
- `meetings.host_user_id` references the user who owns the meeting.
- `participants.meeting_id` and `participants.user_id` are foreign keys, linking each membership to a meeting and user.
- `UNIQUE (meeting_id, user_id)` prevents duplicate participant membership for the same user and meeting. If a product needs multiple simultaneous devices per user, model participant sessions separately rather than removing this invariant without a plan.
- `meeting_records.meeting_id` references one meeting and is unique, providing one summary record per meeting in this example.
- Flexible meeting configuration is stored in `settings` as JSONB; frequently queried fields should remain normal columns or receive suitable indexes.

## 5. Caching strategy

Redis holds data that is hot or short-lived; PostgreSQL remains the durable source of truth.

| Data | Example key | Example expiration | Use |
|---|---|---:|---|
| Meeting metadata | `meeting:{meetingId}` | 1–5 minutes | Avoid repeated database reads for meeting title, status, and settings. |
| Participant presence | `presence:{meetingId}:{participantId}` | 30–90 seconds, refreshed by heartbeat | Quickly determine whether a participant is currently connected. |
| Meeting participant set/count | `meeting:{meetingId}:participants` | Short TTL or event-updated | Support live participant lists and counts. |
| Signaling connection routing | `connection:{userId}:{deviceId}` | Connection lifetime plus short grace period | Help route cross-instance messages to the correct WebSocket server. |
| Rate-limit counters | scoped keys with a short window | Rate-limit window | Protect APIs and signaling from abuse or overload. |

### Expiration, invalidation, and consistency

- Use **TTL (Time to Live)** so stale cache entries expire automatically. Presence expires if a client disappears without a clean leave event.
- On meeting updates or meeting end, update or invalidate the relevant Redis key after the PostgreSQL transaction commits. Publish an event so other application instances can invalidate their local caches as well.
- For important writes, commit to PostgreSQL first; do not acknowledge a durable meeting change based only on a Redis write. For a read-after-write response, return the committed value or read from the primary instead of a potentially lagging replica/cache.
- Presence is best-effort and eventually consistent: a brief delay in a displayed participant count is acceptable, but authorization decisions must be validated against trusted state and tokens, not a stale public cache.
- A cache miss falls back to PostgreSQL and repopulates Redis. Add request coalescing or short-lived negative caching carefully to reduce stampedes without hiding new meetings.

## 6. Messaging and notification workflow

### WebSockets for live updates

After joining, a client keeps a WebSocket connection to a regional WebSocket/signaling server. The server authenticates the connection and subscribes it to the meeting's authorized event stream. It sends events such as:

```json
{
  "type": "participant.joined",
  "meetingId": "mtg_8a21",
  "participant": {
    "participantId": "par_782",
    "displayName": "Sam Lee"
  },
  "occurredAt": "2026-10-13T09:02:14Z"
}
```

WebSockets are appropriate for low-latency, server-to-client updates. Clients should include event IDs or sequence numbers and reconnect with backoff; after reconnect, they can fetch the current participant list to reconcile missed events. WebSockets carry control/signaling and UI events, not the ongoing WebRTC media.

### Kafka event flow

Services publish versioned domain events to Kafka after successful state changes. Example topics include `meeting-events`, `participant-events`, and `notification-requests`. Partitioning by `meetingId` keeps events for one meeting ordered within a partition. Consumers should be idempotent because delivery can be repeated; use an outbox table or equivalent reliable-publishing pattern so a committed database change is not lost if publishing fails.

```text
REST request
  -> Meeting/participant service validates and commits PostgreSQL transaction
  -> Reliable event publication (outbox -> Kafka)
  -> Kafka consumers:
       - WebSocket notifier -> participant.joined / participant.left / meeting.ended
       - Notification worker -> invitation email or mobile push
       - Analytics/audit consumer -> reporting and compliance records
       - Recording worker -> start/stop recording jobs and persist recording metadata
```

### Event examples and notification channels

| Event | Immediate participant update | Optional asynchronous action |
|---|---|---|
| Participant joins | Broadcast `participant.joined` over WebSocket; update participant list. | Update analytics and peak attendance. |
| Participant leaves | Broadcast `participant.left`; refresh presence/count. | Close or finalize session metrics. |
| Chat message | Deliver to authorized meeting members over WebSocket; persist if chat history is supported. | Moderate, index, or retain according to product policy. |
| Meeting invitation | Show in-app invitation or invitation event. | Send email or mobile push if requested or the invitee is offline. |
| Meeting ends | Broadcast `meeting.ended`; clients close their meeting UI and media sessions. | Stop recording, send summaries, and finalize meeting records. |

Email and push providers should be called by background workers rather than during the user's critical API request. Retries use bounded backoff, and a dead-letter queue or failed-event store supports investigation of repeated failures. Notification preference, consent, and delivery status should be respected and recorded where appropriate.

## 7. Scaling and fault tolerance for thousands of participants

### Backend and API capacity

- Keep API and application services stateless where practical, then add instances horizontally behind load balancers. Store durable state in PostgreSQL and shared transient state in Redis rather than relying on one process's memory.
- Use readiness/liveness health checks. Readiness checks keep an overloaded or starting instance out of traffic; liveness checks allow orchestration to restart a stuck process.
- Apply API and WebSocket connection rate limits by user, IP, and meeting. Authenticate all requests and authorize each action by meeting role. Use short-lived, scoped tokens for signaling/media admission.
- Cache read-heavy meeting data and use PostgreSQL read replicas for appropriate list/detail queries. Route writes and consistency-sensitive reads to the primary. Monitor replica lag and avoid replicas for decisions that need the latest committed state.
- Add indexes based on observed query patterns. For very large history tables, partition by time or another well-justified key; archive old records and keep large recording files in object storage, not in PostgreSQL.

### Media, regions, and networking

- Run multiple SFU media servers in each region. Assign a meeting to an SFU or a coordinated SFU group based on region, available network capacity, and participant count. Do not send media through the API Gateway.
- Scale SFUs using active publishers/subscribers, CPU, packet loss, and especially network ingress/egress bandwidth. Capacity-test realistic codecs, resolutions, and subscription patterns; participant count alone is not enough to estimate media load.
- For very large meetings, avoid forwarding every high-resolution video track to every user. Use simulcast or scalable video coding when supported, and let the SFU select layers based on each viewer's layout and bandwidth. Consider a dedicated broadcast/watch mode for audiences much larger than an interactive meeting.
- Choose a nearby region for signaling and media to reduce latency, while meeting data may be served from a regional or global application tier. Keep signaling region and media region aligned when feasible.
- Use STUN for ICE address discovery and TURN relay fallback where direct paths fail. TURN can consume substantial bandwidth, so monitor relay usage and scale it separately.
- WebRTC uses encrypted transport (DTLS-SRTP for media); use HTTPS/WSS for APIs and signaling. For true end-to-end encryption, SFU forwarding requires an additional design (for example, client-side frame encryption) because the SFU otherwise terminates the media transport. Protect recordings and keys with appropriate access controls.

### Async work, auto-scaling, and monitoring

- Kafka buffers asynchronous events and separates user-facing API latency from email, analytics, and recording work. Scale consumers based on topic lag and processing time.
- Auto-scale backend and WebSocket services using CPU, memory, request rate, active connections, and queue lag. Auto-scale SFUs using active media sessions, bitrate/network bandwidth, CPU, and packet quality. Include cooldowns and capacity headroom to avoid rapid oscillation.
- Monitor API latency/error rates, database connections and replica lag, Redis hit rate, WebSocket connections/reconnects, Kafka lag, SFU bandwidth/packet loss/jitter, TURN relay percentage, and meeting join success. Use dashboards, alerts, logs, and distributed traces with request/meeting correlation IDs.
- Protect media and signaling capacity with admission control: if a region or SFU pool reaches a safe threshold, route new meetings elsewhere or reject new joins with a clear retry response instead of degrading every active meeting.

### Failure handling and traffic spikes

- **Backend instance failure:** health checks stop new traffic to the instance; clients retry safe/idempotent requests against another instance.
- **WebSocket disconnect or network interruption:** clients reconnect with exponential backoff and jitter, reauthenticate, rejoin signaling, and fetch a current snapshot. WebRTC may attempt ICE restart; if that fails, the client creates a new media session.
- **SFU failure:** detect the failed media session and direct affected participants to a healthy SFU. They renegotiate WebRTC and republish media. This can cause a brief interruption; active media is not guaranteed to survive a server crash without renegotiation.
- **Database failure:** use managed PostgreSQL high availability, backups, and tested failover. Applications should use bounded retries and avoid retry storms. Read replicas can serve eligible reads but do not replace backups.
- **Redis failure:** treat cache/presence as recoverable, degrade carefully to the database for durable reads, and rate-limit fallback load. Presence can be rebuilt as clients reconnect/heartbeat.
- **Kafka/consumer slowdown:** Kafka retains events for later processing; consumer lag alerts operators. Critical state changes remain durable in PostgreSQL, and reliable event publication prevents losing their follow-up events.
- **Sudden traffic spike:** absorb bursty background work in Kafka, use autoscaling and admission control, protect services with rate limits, and direct new meetings to regions with headroom. Prioritize existing media sessions over optional analytics or non-urgent notifications.

## 8. Conclusion

This architecture separates durable meeting management, real-time signaling, and media forwarding into components that can scale independently. PostgreSQL protects relational data, Redis accelerates frequently read and temporary state, and Kafka supports reliable asynchronous workflows. WebSockets coordinate real-time updates, while WebRTC media flows through regional SFUs with STUN/TURN support. Horizontal scaling, regional capacity planning, observability, and explicit failure recovery make the design suitable for thousands of concurrent participants.
