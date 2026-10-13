(() => {
  const dashboard = document.querySelector("#dashboard");
  const room = document.querySelector("#room");
  const meetingDialog = document.querySelector("#meetingDialog");
  const joinDialog = document.querySelector("#joinDialog");
  const inviteDialog = document.querySelector("#inviteDialog");
  const meetingList = document.querySelector("#meetingList");
  const toast = document.querySelector("#toast");
  const storageKey = "meetly-meetings-v1";
  let meetings = loadMeetings();
  let currentMeeting = null;
  let roomStartedAt = 0;
  let durationTimer;
  let toastTimer;
  let screenStream = null;
  let micMuted = false;
  let cameraOff = false;

  function loadMeetings() {
    try {
      const saved = JSON.parse(localStorage.getItem(storageKey) || "[]");
      return Array.isArray(saved) ? saved : [];
    } catch (error) {
      console.warn("Could not load saved meetings.", error);
      return [];
    }
  }

  function saveMeetings() {
    try {
      localStorage.setItem(storageKey, JSON.stringify(meetings));
    } catch (error) {
      console.warn("Could not save meetings in this browser.", error);
      showToast("Meeting saved for this session only.");
    }
  }

  function esc(value) {
    return String(value).replace(/[&<>"']/g, (char) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
    })[char]);
  }

  function showToast(message) {
    toast.textContent = message;
    toast.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove("show"), 2600);
  }

  function makeId() {
    return `mtg-${Math.random().toString(36).slice(2, 8)}`;
  }

  function dateLabel(dateString) {
    const date = new Date(`${dateString}T12:00:00`);
    return {
      weekday: date.toLocaleDateString(undefined, { weekday: "short" }).toUpperCase(),
      day: date.toLocaleDateString(undefined, { day: "2-digit" })
    };
  }

  function renderMeetings() {
    const now = new Date();
    const upcoming = meetings
      .filter((meeting) => new Date(`${meeting.date}T${meeting.time || "00:00"}`) >= new Date(now.getFullYear(), now.getMonth(), now.getDate()))
      .sort((a, b) => `${a.date}T${a.time}`.localeCompare(`${b.date}T${b.time}`));
    document.querySelector("#meetingCount").textContent = upcoming.length;
    meetingList.innerHTML = upcoming.map((meeting) => {
      const date = dateLabel(meeting.date);
      const isToday = meeting.date === new Date().toISOString().slice(0, 10);
      return `<article class="meeting-card">
        <div class="date-tile"><span>${isToday ? "TODAY" : date.weekday}</span><strong>${date.day}</strong></div>
        <div class="meeting-info"><strong>${esc(meeting.title)}</strong><p>${esc(meeting.duration)} min · ${esc(meeting.id)}</p></div>
        <div class="meeting-time"><strong>${esc(formatTime(meeting.time))}</strong>${isToday ? "Today" : new Date(`${meeting.date}T12:00:00`).toLocaleDateString(undefined, { month: "short", day: "numeric" })}</div>
        <div class="meeting-actions"><div class="meeting-people"><span class="mini-avatar avatar-you">JL</span><span class="mini-avatar avatar-sam">SR</span><span class="mini-avatar avatar-priya">PS</span><span class="more-people">+2</span></div><button class="button button-primary join-meeting" data-id="${esc(meeting.id)}">Join</button><button class="meeting-more delete-meeting" data-id="${esc(meeting.id)}" aria-label="Remove meeting">···</button></div>
      </article>`;
    }).join("");
    document.querySelector("#emptyState").hidden = upcoming.length > 0;
    meetingList.hidden = upcoming.length === 0;
  }

  function formatTime(time) {
    if (!time) return "Time not set";
    const [hours, minutes] = time.split(":").map(Number);
    const date = new Date();
    date.setHours(hours, minutes);
    return date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  }

  function setGreeting() {
    const now = new Date();
    const hour = now.getHours();
    const greeting = hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";
    document.querySelector("#welcomeTitle").innerHTML = `${greeting}, Jamie <span>✦</span>`;
    document.querySelector("#greeting").textContent = now.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" }).toUpperCase();
    document.querySelector("#todayLabel").textContent = now.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
    const dateInput = document.querySelector("#meetingDate");
    dateInput.min = now.toISOString().slice(0, 10);
    dateInput.value = dateInput.min;
    document.querySelector("#meetingTime").value = `${String(Math.min(now.getHours() + 1, 23)).padStart(2, "0")}:00`;
  }

  function createMeeting(title, date, time, duration) {
    const meeting = { id: makeId(), title, date, time, duration, createdAt: new Date().toISOString() };
    meetings.push(meeting);
    saveMeetings();
    renderMeetings();
    return meeting;
  }

  function openRoom(meeting) {
    currentMeeting = meeting;
    dashboard.hidden = true;
    room.hidden = false;
    document.querySelector("#roomMeetingTitle").textContent = meeting.title;
    document.querySelector("#inviteLinkText").textContent = `${location.origin}/join/${meeting.id}`;
    roomStartedAt = Date.now();
    updateDuration();
    clearInterval(durationTimer);
    durationTimer = setInterval(updateDuration, 1000);
    document.querySelector("#chatMessages").scrollTop = document.querySelector("#chatMessages").scrollHeight;
    document.body.classList.add("in-room");
  }

  function updateDuration() {
    if (!roomStartedAt) return;
    const elapsed = Math.floor((Date.now() - roomStartedAt) / 1000);
    document.querySelector("#roomDuration").textContent = `${String(Math.floor(elapsed / 60)).padStart(2, "0")}:${String(elapsed % 60).padStart(2, "0")}`;
  }

  function closeRoom(ended = false) {
    clearInterval(durationTimer);
    if (screenStream) {
      screenStream.getTracks().forEach((track) => track.stop());
      screenStream = null;
    }
    if (ended && currentMeeting) {
      meetings = meetings.filter((meeting) => meeting.id !== currentMeeting.id);
      saveMeetings();
      renderMeetings();
      showToast("Meeting ended for everyone.");
    } else {
      showToast("You left the meeting.");
    }
    room.hidden = true;
    dashboard.hidden = false;
    document.body.classList.remove("in-room");
    currentMeeting = null;
    micMuted = false;
    cameraOff = false;
    document.querySelector("#micButton").classList.remove("muted-control");
    document.querySelector("#micButton small").textContent = "Mute";
    document.querySelector("#cameraButton small").textContent = "Stop video";
  }

  function activeMeeting() {
    return currentMeeting || {
      id: makeId(),
      title: "Instant meeting",
      date: new Date().toISOString().slice(0, 10),
      time: new Date().toTimeString().slice(0, 5),
      duration: 60
    };
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      showToast("Meeting link copied to clipboard.");
    } catch {
      const input = document.createElement("textarea");
      input.value = text;
      input.style.position = "fixed";
      input.style.opacity = "0";
      document.body.appendChild(input);
      input.select();
      const copied = document.execCommand("copy");
      input.remove();
      showToast(copied ? "Meeting link copied to clipboard." : text);
    }
  }

  function inviteUrl() {
    return `${location.origin}/join/${currentMeeting ? currentMeeting.id : "your-meeting-code"}`;
  }

  function showInvite() {
    document.querySelector("#inviteLinkText").textContent = inviteUrl();
    inviteDialog.showModal();
  }

  document.querySelector("#createButton").addEventListener("click", () => meetingDialog.showModal());
  document.querySelector("#emptyCreateButton").addEventListener("click", () => meetingDialog.showModal());
  document.querySelector('[data-action="create-meeting"]').addEventListener("click", () => meetingDialog.showModal());
  document.querySelector("#startButton").addEventListener("click", () => openRoom(activeMeeting()));
  document.querySelector("#joinButton").addEventListener("click", () => joinDialog.showModal());
  document.querySelector("#inviteButton").addEventListener("click", showInvite);
  document.querySelector("#addParticipantButton").addEventListener("click", showInvite);
  document.querySelector("#roomInviteButton").addEventListener("click", () => copyText(inviteUrl()));
  document.querySelector("#copyRoomLink").addEventListener("click", () => copyText(inviteUrl()));
  document.querySelector("#peopleInviteButton").addEventListener("click", showInvite);
  document.querySelector("#copyInviteButton").addEventListener("click", () => copyText(inviteUrl()));
  document.querySelector("#leaveButton").addEventListener("click", () => closeRoom(false));
  document.querySelector("#roomMoreButton").addEventListener("click", () => {
    if (confirm("End this meeting for everyone?")) closeRoom(true);
  });
  document.querySelector("#moreRoomButton").addEventListener("click", () => {
    if (confirm("End this meeting for everyone?")) closeRoom(true);
  });
  document.querySelector("#helpButton").addEventListener("click", () => showToast("Tip: schedule a meeting or start an instant room."));
  document.querySelector("#viewAllButton").addEventListener("click", () => showToast("You're viewing all upcoming meetings."));

  document.querySelectorAll("[data-view]").forEach((button) => {
    button.addEventListener("click", () => {
      document.querySelectorAll("[data-view]").forEach((item) => item.classList.toggle("active", item === button));
      const view = button.dataset.view;
      document.querySelector("#pageTitle").textContent = view === "home" ? "Overview" : view === "meetings" ? "Meetings" : "Contacts";
      document.querySelector("#meetingHeading").innerHTML = `${view === "contacts" ? "Your team" : "Upcoming meetings"} <span class="count-pill" id="meetingCount">${meetings.length}</span>`;
      if (view === "contacts") showToast("Team contacts are ready to invite from a meeting.");
      else renderMeetings();
    });
  });

  document.querySelector("#meetingForm").addEventListener("submit", (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const meeting = createMeeting(form.get("title").trim(), form.get("date"), form.get("time"), Number(form.get("duration")));
    meetingDialog.close();
    event.currentTarget.reset();
    setGreeting();
    document.querySelector('[data-view="meetings"]').click();
    showToast(`"${meeting.title}" has been scheduled.`);
  });

  document.querySelector("#joinForm").addEventListener("submit", (event) => {
    event.preventDefault();
    const value = document.querySelector("#joinCode").value.trim();
    if (!value) return;
    const id = value.match(/(?:join\/)?(mtg-[a-z0-9]+)/i)?.[1] || value;
    const existing = meetings.find((meeting) => meeting.id.toLowerCase() === id.toLowerCase());
    const meeting = existing || { id, title: "Guest meeting", date: new Date().toISOString().slice(0, 10), time: new Date().toTimeString().slice(0, 5), duration: 60 };
    joinDialog.close();
    event.currentTarget.reset();
    openRoom(meeting);
    if (!existing) showToast(`Joined demo room ${id}.`);
  });

  document.querySelector("#inviteForm").addEventListener("submit", (event) => {
    event.preventDefault();
    const email = document.querySelector("#inviteEmail").value.trim();
    if (!email) {
      copyText(inviteUrl());
      return;
    }
    inviteDialog.close();
    event.currentTarget.reset();
    showToast(`Invite prepared for ${email}.`);
  });

  meetingList.addEventListener("click", (event) => {
    const join = event.target.closest(".join-meeting");
    const remove = event.target.closest(".delete-meeting");
    if (join) {
      const meeting = meetings.find((item) => item.id === join.dataset.id);
      if (meeting) openRoom(meeting);
    }
    if (remove && confirm("Remove this meeting from your schedule?")) {
      meetings = meetings.filter((item) => item.id !== remove.dataset.id);
      saveMeetings();
      renderMeetings();
      showToast("Meeting removed from your schedule.");
    }
  });

  document.querySelectorAll("[data-close-dialog]").forEach((button) => {
    button.addEventListener("click", () => button.closest("dialog").close());
  });

  document.querySelector("#micButton").addEventListener("click", (event) => {
    micMuted = !micMuted;
    event.currentTarget.querySelector("small").textContent = micMuted ? "Unmute" : "Mute";
    event.currentTarget.classList.toggle("muted-control", micMuted);
    document.querySelector("#tileJamie .audio-wave").textContent = micMuted ? "×" : "▮";
    showToast(micMuted ? "Microphone muted." : "Microphone on.");
  });

  document.querySelector("#cameraButton").addEventListener("click", (event) => {
    cameraOff = !cameraOff;
    event.currentTarget.querySelector("small").textContent = cameraOff ? "Start video" : "Stop video";
    document.querySelector("#tileJamie .tile-background").style.opacity = cameraOff ? ".25" : "1";
    showToast(cameraOff ? "Camera turned off." : "Camera turned on.");
  });

  document.querySelector("#shareButton").addEventListener("click", async (event) => {
    if (screenStream) {
      screenStream.getTracks().forEach((track) => track.stop());
      screenStream = null;
      event.currentTarget.querySelector("small").textContent = "Share screen";
      showToast("Screen sharing stopped.");
      return;
    }
    if (!navigator.mediaDevices?.getDisplayMedia) {
      showToast("Screen sharing is not available in this browser.");
      return;
    }
    try {
      screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true });
      event.currentTarget.querySelector("small").textContent = "Stop sharing";
      screenStream.getVideoTracks()[0].addEventListener("ended", () => {
        screenStream = null;
        event.currentTarget.querySelector("small").textContent = "Share screen";
      }, { once: true });
      showToast("Screen sharing started in this demo.");
    } catch (error) {
      if (error.name !== "NotAllowedError") console.error("Screen sharing failed.", error);
      showToast(error.name === "NotAllowedError" ? "Screen sharing was cancelled." : "Could not start screen sharing.");
    }
  });

  document.querySelector("#reactionsButton").addEventListener("click", () => showToast("😊 Reaction sent."));

  document.querySelector("#chatForm").addEventListener("submit", (event) => {
    event.preventDefault();
    const input = document.querySelector("#chatInput");
    const message = input.value.trim();
    if (!message) return;
    const item = document.createElement("div");
    item.className = "chat-message";
    const avatar = document.createElement("div");
    avatar.className = "avatar avatar-you";
    avatar.textContent = "JL";
    const body = document.createElement("div");
    const meta = document.createElement("div");
    meta.className = "message-meta";
    const author = document.createElement("strong");
    author.textContent = "Jamie Lee";
    const time = document.createElement("time");
    time.textContent = new Date().toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
    const text = document.createElement("p");
    text.textContent = message;
    meta.append(author, time);
    body.append(meta, text);
    item.append(avatar, body);
    document.querySelector("#chatMessages").append(item);
    input.value = "";
    item.scrollIntoView({ block: "nearest" });
  });

  document.querySelectorAll(".panel-tab").forEach((tab) => {
    tab.addEventListener("click", () => setPanel(tab.dataset.panel));
  });
  document.querySelector("#chatButton").addEventListener("click", () => setPanel("chat"));
  document.querySelector("#participantsButton").addEventListener("click", () => setPanel("people"));
  document.querySelector("#closePanel").addEventListener("click", () => document.querySelector("#meetingPanel").classList.toggle("panel-hidden"));

  function setPanel(panel) {
    document.querySelector("#meetingPanel").classList.remove("panel-hidden");
    document.querySelectorAll(".panel-tab").forEach((tab) => tab.classList.toggle("active", tab.dataset.panel === panel));
    document.querySelector("#chatPanel").hidden = panel !== "chat";
    document.querySelector("#peoplePanel").hidden = panel !== "people";
    document.querySelector("#chatButton").classList.toggle("active-control", panel === "chat");
    document.querySelector("#participantsButton").classList.toggle("active-control", panel === "people");
  }

  window.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !room.hidden && document.querySelector("#meetingPanel").classList.contains("panel-hidden")) {
      document.querySelector("#meetingPanel").classList.remove("panel-hidden");
    }
  });

  setGreeting();
  renderMeetings();
})();
