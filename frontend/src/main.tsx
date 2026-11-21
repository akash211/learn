import React from "react";
import ReactDOM from "react-dom/client";
import { createBrowserRouter, RouterProvider } from "react-router-dom";
import App from "./App";
import Dashboard from "./pages/Dashboard";
import Technologies from "./pages/Technologies";
import TechPage from "./pages/TechPage";
import Chapter from "./pages/Chapter";
import QuickRevision from "./pages/QuickRevision";
import MockInterview from "./pages/MockInterview";
import Playground from "./pages/Playground";
import TechMap from "./pages/TechMap";
import Bookmarks from "./pages/Bookmarks";
import Notes from "./pages/Notes";
import Queue from "./pages/Queue";
import History from "./pages/History";
import Settings from "./pages/Settings";
import "./index.css";

const router = createBrowserRouter([
  {
    path: "/",
    element: <App />,
    children: [
      { index: true, element: <Dashboard /> },
      { path: "techs", element: <Technologies /> },
      { path: "tech/:slug", element: <TechPage /> },
      { path: "tech/:slug/chapter/:id", element: <Chapter /> },
      { path: "revision", element: <QuickRevision /> },
      { path: "revision/:slug", element: <QuickRevision /> },
      { path: "interview", element: <MockInterview /> },
      { path: "playground", element: <Playground /> },
      { path: "map", element: <TechMap /> },
      { path: "bookmarks", element: <Bookmarks /> },
      { path: "notes", element: <Notes /> },
      { path: "queue", element: <Queue /> },
      { path: "history", element: <History /> },
      { path: "settings", element: <Settings /> },
      { path: "*", element: <Dashboard /> },
    ],
  },
]);

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <RouterProvider router={router} />
  </React.StrictMode>,
);
