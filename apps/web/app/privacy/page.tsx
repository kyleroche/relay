import { TrustArticle, trustMetadata } from "@/components/trust/trust-article";

export const metadata = trustMetadata("privacy");

export default function PrivacyPage() {
  return <TrustArticle slug="privacy" />;
}
