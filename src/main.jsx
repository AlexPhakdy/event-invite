import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import BirthdayInvite from "../birthday_invite.jsx";

createRoot(document.getElementById("root")).render(
  <StrictMode>
    <BirthdayInvite />
  </StrictMode>
);

// hand off from the static pre-JS loader to React's own boot animation
document.getElementById("preloader")?.remove();
