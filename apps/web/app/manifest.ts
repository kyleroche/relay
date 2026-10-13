import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "relay",
    short_name: "relay",
    description: "Your coding-agent subscriptions, working as one system. Feed, projects, usage and workers.",
    start_url: "/",
    display: "standalone",
    background_color: "#fbfbfa",
    theme_color: "#3d78a8",
    icons: [{ src: "/icon.svg", sizes: "any", type: "image/svg+xml" }],
  };
}
