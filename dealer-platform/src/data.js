import starterCars from "../../inventory-seed.json" with { type: "json" };
export { starterCars };

export const dealer = {
  name: "Tristar Motors", phone: "+254 734 490475", whatsapp: "254734490475",
  address: "La Colline Garden, Masaba Road, Upper Hill, Nairobi, Kenya", hours: "Viewing by appointment",
  tagline: "Mercedes! Mercedes! Mercedes or nothing.",
  priceTagline: "If there's no price tag, it's not for sale.",
  registrationEstimate: 399, salesTaxRate: 0.06,
};

export const money = (value) => new Intl.NumberFormat("en-KE", { style:"currency", currency:"KES", maximumFractionDigits:0 }).format(Number(value)||0);
export const number = (value) => new Intl.NumberFormat("en-US").format(Number(value)||0);
