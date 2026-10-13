import { REPO_URL, SITE_URL } from "@/lib/data";

export function softwareApplicationLd() {
  return {
    "@context": "https://schema.org",
    "@type": "SoftwareApplication",
    name: "relay",
    url: SITE_URL,
    applicationCategory: "DeveloperApplication",
    operatingSystem: "macOS, Linux",
    description:
      "An open-source harness that turns one person's coding-agent subscriptions (Claude Code, Codex, Grok) into one system: GitHub issues as the task bus, self-hosted runners on your own machines, shared memory in Postgres, and an event feed of everything agents did and what it cost.",
    offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
    license: "https://www.apache.org/licenses/LICENSE-2.0",
    codeRepository: REPO_URL,
    softwareHelp: `${SITE_URL}/docs`,
    isAccessibleForFree: true,
  };
}

export function organizationLd() {
  return {
    "@context": "https://schema.org",
    "@type": "Organization",
    name: "relay",
    url: SITE_URL,
    logo: `${SITE_URL}/icon.svg`,
    sameAs: [REPO_URL],
  };
}

export function JsonLd({ data }: { data: object | object[] }) {
  const items = Array.isArray(data) ? data : [data];
  return (
    <>
      {items.map((d, i) => (
        <script key={i} type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(d) }} />
      ))}
    </>
  );
}
