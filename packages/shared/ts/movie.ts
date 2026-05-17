/**
 * Movie / MovieCard 型 (web 側で利用)。
 *
 * Source of Truth: apps/api/app/schemas/movie.py
 * jsonschema: ./jsonschema/movie.schema.json
 */

export type PriceList = {
  list_price: number | null;
  sale_price: number | null;
  rental_price: number | null;
  delivery_price: number | null;
};

export type ActressBrief = {
  id: number;
  name: string;
  slug: string | null;
  thumbnail_url: string | null;
};

export type MovieCard = {
  id: string;
  content_id: string | null;
  title: string;
  slug: string;
  image_url_list: string | null;
  image_url_large: string | null;
  sample_movie_url: string | null;
  affiliate_url: string;
  price_list: PriceList | null;
  price_min: number | null;
  review_count: number;
  review_average: number | null;
  release_date: string | null;
};

export type MovieDetail = MovieCard & {
  duration_minutes: number | null;
  maker: string | null;
  label: string | null;
  series: string | null;
  director: string | null;
  actresses: ActressBrief[];
  genres: string[];
  description: string | null;
};
