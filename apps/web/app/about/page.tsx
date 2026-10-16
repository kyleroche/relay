import { TrustArticle, trustMetadata } from "@/components/trust/trust-article";

export const metadata = trustMetadata("about");

export default function AboutPage() {
  return <TrustArticle slug="about" />;
}
