import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Terms of Service | Clandestine Fulfillment",
  description: "Terms of Service for Clandestine Fulfillment services",
};

export default function TermsPage() {
  return (
    <div className="min-h-screen bg-background py-12 px-4 sm:px-6 lg:px-8">
      <div className="max-w-3xl mx-auto [&>h1]:text-3xl [&>h1]:font-bold [&>h1]:mb-4 [&>h2]:text-xl [&>h2]:font-semibold [&>h2]:mt-8 [&>h2]:mb-3 [&>p]:mb-4 [&>p]:text-muted-foreground [&>ul]:list-disc [&>ul]:pl-6 [&>ul]:mb-4 [&>ul>li]:text-muted-foreground [&>ul>li]:mb-1">
        <h1>Terms of Service</h1>
        <p className="!text-sm !text-muted-foreground/70">Last updated: March 2026</p>

        <h2>1. Agreement to Terms</h2>
        <p>
          By accessing or using the Clandestine Fulfillment platform ("Service"), you agree to be
          bound by these Terms of Service. If you do not agree to these terms, please do not use our
          Service.
        </p>

        <h2>2. Description of Service</h2>
        <p>
          Clandestine Fulfillment provides warehouse fulfillment and inventory management services
          for record labels, distributors, and music merchandise sellers. Our platform integrates
          with third-party e-commerce platforms including Shopify, Squarespace, WooCommerce, and
          Bandcamp to synchronize inventory levels and manage order fulfillment.
        </p>

        <h2>3. Account Registration</h2>
        <p>
          To use our Service, you must create an account and provide accurate, complete information.
          You are responsible for maintaining the security of your account credentials and for all
          activities that occur under your account.
        </p>

        <h2>4. Third-Party Integrations</h2>
        <p>
          Our Service integrates with third-party platforms to provide inventory synchronization. By
          connecting your third-party accounts (such as Shopify, Squarespace, WooCommerce, or
          Bandcamp), you authorize us to access and modify inventory data on those platforms on your
          behalf. We only request the minimum permissions necessary for inventory management.
        </p>

        <h2>5. Data and Inventory Accuracy</h2>
        <p>
          While we strive to maintain accurate inventory synchronization, you acknowledge that
          technical issues, network delays, or third-party platform limitations may occasionally
          cause discrepancies. We recommend periodic manual verification of inventory levels.
        </p>

        <h2>6. Acceptable Use</h2>
        <p>You agree not to:</p>
        <ul>
          <li>Use the Service for any unlawful purpose</li>
          <li>Attempt to gain unauthorized access to our systems</li>
          <li>Interfere with or disrupt the Service</li>
          <li>Share your account credentials with unauthorized parties</li>
        </ul>

        <h2>7. Limitation of Liability</h2>
        <p>
          To the maximum extent permitted by law, Clandestine Distribution shall not be liable for
          any indirect, incidental, special, consequential, or punitive damages, including but not
          limited to loss of profits, data, or business opportunities arising from your use of the
          Service.
        </p>

        <h2>8. Modifications to Terms</h2>
        <p>
          We reserve the right to modify these Terms at any time. We will notify users of
          significant changes via email or through the Service. Continued use of the Service after
          changes constitutes acceptance of the modified Terms.
        </p>

        <h2>9. Termination</h2>
        <p>
          Either party may terminate this agreement at any time. Upon termination, your access to
          the Service will be revoked, and we will disconnect any third-party integrations
          associated with your account.
        </p>

        <h2>10. Contact</h2>
        <p>
          For questions about these Terms, please contact us at{" "}
          <a href="mailto:support@clandestinedistro.com" className="text-primary underline">
            support@clandestinedistro.com
          </a>
          .
        </p>
      </div>
    </div>
  );
}
