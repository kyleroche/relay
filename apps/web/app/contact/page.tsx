import { TrustArticle, trustMetadata } from "@/components/trust/trust-article";

export const metadata = trustMetadata("contact");

// RELAY_CONTACT_EMAIL is read at request time so the page follows the environment, not the build.
export const dynamic = "force-dynamic";

export default function ContactPage() {
  return <TrustArticle slug="contact" />;
}
