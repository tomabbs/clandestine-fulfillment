import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Privacy Policy | Clandestine Fulfillment",
  description: "Privacy Policy for Clandestine Fulfillment services",
};

export default function PrivacyPage() {
  return (
    <div className="min-h-screen bg-background py-12 px-4 sm:px-6 lg:px-8">
      <div className="max-w-3xl mx-auto [&>h1]:text-3xl [&>h1]:font-bold [&>h1]:mb-4 [&>h2]:text-xl [&>h2]:font-semibold [&>h2]:mt-8 [&>h2]:mb-3 [&>h3]:text-lg [&>h3]:font-medium [&>h3]:mt-4 [&>h3]:mb-2 [&>p]:mb-4 [&>p]:text-muted-foreground [&>ul]:list-disc [&>ul]:pl-6 [&>ul]:mb-4 [&>ul>li]:text-muted-foreground [&>ul>li]:mb-1">
        <h1>Privacy Policy</h1>
        <p className="!text-sm !text-muted-foreground/70">Last updated: March 2026</p>

        <h2>1. Introduction</h2>
        <p>
          Clandestine Distribution ("we", "our", or "us") operates the Clandestine Fulfillment
          platform. This Privacy Policy explains how we collect, use, and protect information when
          you use our Service.
        </p>

        <h2>2. Information We Collect</h2>

        <h3>Account Information</h3>
        <p>
          When you create an account, we collect your name, email address, and organization details
          necessary to provide our services.
        </p>

        <h3>Integration Data</h3>
        <p>
          When you connect third-party platforms (Shopify, Squarespace, WooCommerce, Bandcamp), we
          access:
        </p>
        <ul>
          <li>Product and inventory information (SKUs, quantities, titles)</li>
          <li>Order information for fulfillment purposes</li>
          <li>Store configuration data necessary for integration</li>
        </ul>
        <p>
          We do NOT access or store payment information, customer passwords, or sensitive financial
          data from connected platforms.
        </p>

        <h3>Usage Data</h3>
        <p>
          We collect information about how you interact with our Service, including pages visited,
          features used, and actions taken within the platform.
        </p>

        <h2>3. How We Use Your Information</h2>
        <p>We use collected information to:</p>
        <ul>
          <li>Provide and maintain our inventory synchronization services</li>
          <li>Process and fulfill orders on your behalf</li>
          <li>Send service-related communications</li>
          <li>Improve and optimize our platform</li>
          <li>Provide customer support</li>
        </ul>

        <h2>4. Data Sharing</h2>
        <p>We do not sell your personal information. We may share data with:</p>
        <ul>
          <li>
            <strong>Third-party platforms:</strong> Only the data necessary to perform inventory
            synchronization with platforms you've authorized
          </li>
          <li>
            <strong>Service providers:</strong> Trusted partners who assist in operating our Service
            (hosting, email delivery)
          </li>
          <li>
            <strong>Legal requirements:</strong> When required by law or to protect our rights
          </li>
        </ul>

        <h2>5. Data Security</h2>
        <p>
          We implement industry-standard security measures to protect your data, including
          encryption in transit and at rest, secure authentication, and regular security audits. API
          credentials for connected platforms are stored securely and never exposed to unauthorized
          parties.
        </p>

        <h2>6. Data Retention</h2>
        <p>
          We retain your data for as long as your account is active or as needed to provide
          services. Upon account termination, we will delete your data within 90 days, except where
          retention is required by law.
        </p>

        <h2>7. Your Rights</h2>
        <p>You have the right to:</p>
        <ul>
          <li>Access the personal information we hold about you</li>
          <li>Request correction of inaccurate information</li>
          <li>Request deletion of your account and associated data</li>
          <li>Disconnect third-party integrations at any time</li>
          <li>Export your data in a machine-readable format</li>
        </ul>

        <h2>8. Third-Party Platforms</h2>
        <p>
          Our Service integrates with third-party platforms that have their own privacy policies. We
          encourage you to review the privacy policies of Shopify, Squarespace, WooCommerce,
          Bandcamp, and any other platforms you connect.
        </p>

        <h2>9. Changes to This Policy</h2>
        <p>
          We may update this Privacy Policy periodically. We will notify you of significant changes
          via email or through the Service. The "Last updated" date at the top indicates when the
          policy was last revised.
        </p>

        <h2>10. Contact Us</h2>
        <p>
          For privacy-related questions or to exercise your rights, contact us at:{" "}
          <a href="mailto:privacy@clandestinedistro.com" className="text-primary underline">
            privacy@clandestinedistro.com
          </a>
        </p>
      </div>
    </div>
  );
}
